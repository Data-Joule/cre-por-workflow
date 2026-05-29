/**
 * PoR attestation workflow — runs on each CRE DON node every 2 minutes.
 *
 * Flow:
 *   1. Each node GETs data-joule.com/api/events/log (no-store) and sums kwh_scaled
 *   2. DON consensus reconciles the per-node {total, count} (median per field)
 *   3. EVM read: current JouleCreditReserve.attestedKwhTotal()
 *   4. Skip if consensus total <= current (nothing new); hard-fail if the jump
 *      exceeds maxDeltaPerWrite (catches data corruption / schema drift)
 *   5. Sign a report carrying abi.encode(uint256 newTotal) and writeReport() it to
 *      the reserve — the KeystoneForwarder delivers it to onReport(), which decodes
 *      the uint256 and enforces monotonicity on-chain.
 *
 * Written against @chainlink/cre-sdk 1.10.x, modeled on the official
 * proof-of-reserve example in smartcontractkit/cre-sdk-typescript.
 */

import {
  ConsensusAggregationByFields,
  CronCapability,
  type CronPayload,
  EVMClient,
  encodeCallMsg,
  getNetwork,
  HTTPClient,
  type HTTPSendRequester,
  handler,
  LAST_FINALIZED_BLOCK_NUMBER,
  median,
  prepareReportRequest,
  Runner,
  type Runtime,
  TxStatus,
  text,
  bytesToHex,
} from "@chainlink/cre-sdk";
import {
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  encodeAbiParameters,
  zeroAddress,
} from "viem";
import { z } from "zod";
import { sumKwhScaled, type Attestation } from "./src/compute";
import { JouleCreditReserveAbi } from "./src/abi";

const configSchema = z.object({
  schedule: z.string(),
  apiUrl: z.string(),
  reserveAddress: z.string(),
  chainSelectorName: z.string(),
  maxDeltaPerWrite: z.string(),
});
type Config = z.infer<typeof configSchema>;

// Runs in node mode on every DON node. Fetches the event log and reduces it to
// a deterministic {total, count} that consensus can reconcile.
const fetchAttestation = (sendRequester: HTTPSendRequester, config: Config): Attestation => {
  const response = sendRequester.sendRequest({ url: config.apiUrl, method: "GET" }).result();
  if (response.statusCode !== 200) {
    throw new Error(`HTTP ${response.statusCode} from ${config.apiUrl}`);
  }
  return sumKwhScaled(JSON.parse(text(response)));
};

const reserveEvmClient = (runtime: Runtime<Config>): EVMClient => {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.chainSelectorName,
    isTestnet: true,
  });
  if (!network) {
    throw new Error(`Network not found for chain selector: ${runtime.config.chainSelectorName}`);
  }
  return new EVMClient(network.chainSelector.selector);
};

const readAttestedTotal = (runtime: Runtime<Config>): bigint => {
  const evm = reserveEvmClient(runtime);
  const callData = encodeFunctionData({ abi: JouleCreditReserveAbi, functionName: "attestedKwhTotal" });
  const call = evm
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: runtime.config.reserveAddress as Address,
        data: callData,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  return decodeFunctionResult({
    abi: JouleCreditReserveAbi,
    functionName: "attestedKwhTotal",
    data: bytesToHex(call.data),
  }) as bigint;
};

const writeAttestation = (runtime: Runtime<Config>, newTotal: bigint): string => {
  const evm = reserveEvmClient(runtime);
  // JouleCreditReserve.onReport does abi.decode(report, (uint256)), so the report
  // payload is a bare ABI-encoded uint256 — not an encoded function call.
  const payload = encodeAbiParameters([{ type: "uint256" }], [newTotal]);
  const report = runtime.report(prepareReportRequest(payload)).result();
  const resp = evm
    .writeReport(runtime, { receiver: runtime.config.reserveAddress, report })
    .result();
  if (resp.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`writeReport failed: ${resp.errorMessage || resp.txStatus}`);
  }
  const txHash = bytesToHex(resp.txHash || new Uint8Array(32));
  runtime.log(`Attestation written: total=${newTotal} tx=${txHash}`);
  return txHash;
};

const doAttestation = (runtime: Runtime<Config>): string => {
  const attestation = new HTTPClient()
    .sendRequest(
      runtime,
      fetchAttestation,
      ConsensusAggregationByFields<Attestation>({ total: median, count: median }),
    )(runtime.config)
    .result();

  const newTotal = BigInt(attestation.total);
  runtime.log(`Consensus attestation: total=${newTotal} count=${attestation.count}`);

  const current = readAttestedTotal(runtime);
  runtime.log(`On-chain attestedKwhTotal=${current}`);

  if (newTotal <= current) {
    runtime.log(`Skip write: newTotal=${newTotal} <= current=${current}`);
    return "skipped";
  }

  const delta = newTotal - current;
  const maxDelta = BigInt(runtime.config.maxDeltaPerWrite);
  if (delta > maxDelta) {
    throw new Error(
      `Delta ${delta} exceeds maxDeltaPerWrite ${maxDelta} — refusing to write. ` +
        `Manual investigation required (likely data corruption or schema change).`,
    );
  }

  return writeAttestation(runtime, newTotal);
};

const onCronTrigger = (runtime: Runtime<Config>, payload: CronPayload): string => {
  if (!payload.scheduledExecutionTime) {
    throw new Error("Scheduled execution time is required");
  }
  runtime.log("PoR cron trigger fired");
  return doAttestation(runtime);
};

const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
