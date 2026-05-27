/**
 * PoR attestation workflow — runs on each CRE DON node every 2 minutes.
 *
 * Flow:
 *   1. HTTP GET data-joule.com/api/events/log (no-store cache header)
 *   2. Each node deterministically computes sum(BigInt(kwh_scaled))
 *   3. DON consensus by identical fields (total + count) — divergence = no write
 *   4. EVM read: currentOnChain = JouleCreditReserve.attestedKwhTotal()
 *   5. Hard-fail guard: delta > maxDeltaPerWrite → workflow aborts (no write)
 *   6. EVM write via writeReport: encoded uint256 → onReport() on the reserve
 *
 * Skips a write when newTotal <= currentOnChain (already at or above ceiling).
 * For heartbeat refresh during quiet periods, see Open Items in the spec —
 * not implemented in v1.
 */

import {
  HTTPClientCapability,
  EVMClientCapability,
  CronCapability,
  handler,
  Runner,
  type Runtime,
  type ConsensusAggregationByFields,
} from "@chainlink/cre-sdk";
import { z } from "zod";
import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import { computeAttestation, type Attestation } from "./src/compute";

type Config = {
  schedule:          string;
  apiUrl:            string;
  reserveAddress:    `0x${string}`;
  chainSelectorName: string;
  maxDeltaPerWrite:  string;
};

const attestationSchema = z.object({
  total: z.string().regex(/^\d+$/),
  count: z.number().int().nonnegative(),
});

const reserveAbi = parseAbi([
  "function attestedKwhTotal() external view returns (uint256)",
]);

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const httpClient = new HTTPClientCapability();
  const evmClient  = new EVMClientCapability();

  // Steps 1–3: fetch → each node sums → DON consensus
  const aggregation: ConsensusAggregationByFields<Attestation> = {
    method: "byFields",
    fields: {
      total: { method: "identical" },
      count: { method: "identical" },
    },
  };

  const attestation = httpClient
    .sendRequest(runtime, computeAttestation, aggregation)(runtime.config.apiUrl)
    .result();

  attestationSchema.parse(attestation);
  const newTotal = BigInt(attestation.total);

  // Step 4: read currentOnChain
  const callData = encodeFunctionData({
    abi: reserveAbi,
    functionName: "attestedKwhTotal",
  });
  const readResult = evmClient
    .callContract(runtime, {
      toAddress:         runtime.config.reserveAddress,
      chainSelectorName: runtime.config.chainSelectorName,
      callMsg:           { data: callData, blockNumber: 0n },
    })
    .result();

  const [currentOnChain] = decodeFunctionResult({
    abi:          reserveAbi,
    functionName: "attestedKwhTotal",
    data:         readResult.data as `0x${string}`,
  }) as [bigint];

  if (newTotal <= currentOnChain) {
    runtime.log(
      `Skip write: newTotal=${newTotal} <= currentOnChain=${currentOnChain} (count=${attestation.count})`,
    );
    return "skipped";
  }

  // Step 5: hard-fail guard against catastrophic deltas
  const delta    = newTotal - currentOnChain;
  const maxDelta = BigInt(runtime.config.maxDeltaPerWrite);
  if (delta > maxDelta) {
    throw new Error(
      `Delta ${delta} exceeds maxDeltaPerWrite ${maxDelta} — refusing to write. ` +
      `Manual investigation required (likely data corruption or schema change).`,
    );
  }

  // Step 6: signed report → KeystoneForwarder → onReport() on the reserve
  const encoded      = encodeAbiParameters(parseAbiParameters("uint256"), [newTotal]);
  const signedReport = runtime.report(encoded);

  const txResult = evmClient
    .writeReport(runtime, {
      toAddress:         runtime.config.reserveAddress,
      chainSelectorName: runtime.config.chainSelectorName,
      report:            signedReport,
      gasLimit:          200000n,
    })
    .result();

  runtime.log(
    `Attestation updated: total=${newTotal} delta=${delta} count=${attestation.count} tx=${txResult.txHash}`,
  );
  return txResult.txHash;
};

const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
