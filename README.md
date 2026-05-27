# cre-por-workflow

Chainlink CRE workflow that maintains the on-chain Proof-of-Reserve attestation for the **JouleCredit** token.

This repository is the **independent attestor** half of the PoR design. The other half is `JouleCreditReserve.sol` in the `joule-credits` repo. Together they enforce: *no JLC mint can exceed the total kWh independently verified by this workflow.*

See the full design at `joule-credits/docs/superpowers/specs/2026-05-27-por-attestation-design.md`.

## What it does

Every 2 minutes, on each CRE DON node:

1. `GET https://data-joule.com/api/events/log`
2. Sum `BigInt(report.kwh_scaled)` across all events
3. DON consensus on the sum (`ConsensusAggregationByFields`, both fields `identical`)
4. Read `JouleCreditReserve.attestedKwhTotal()` on-chain
5. Hard-fail if delta exceeds `maxDeltaPerWrite` (catches bugs / data corruption)
6. If new total > current, sign a report and write via `KeystoneForwarder`

## Project layout

```
cre-por-workflow/
├── project.yaml                # chain config (chain selectors per environment)
├── secrets.yaml                # empty — public API
├── abis/
│   └── JouleCreditReserve.json # copied manually from joule-credits/artifacts/
└── por-workflow/
    ├── workflow.yaml
    ├── config.staging.json     # Polygon Amoy
    ├── config.production.json  # Polygon Mainnet (future)
    ├── main.ts                 # CRE workflow handler
    ├── src/compute.ts          # extracted for unit testing
    ├── package.json
    ├── tsconfig.json
    └── test/
        ├── compute.test.ts     # vitest unit tests
        └── fixtures/           # frozen snapshots of /api/events/log
```

## Prerequisites

- Bun or Node 20+
- `@chainlink/cre-cli` installed (CRE Early Access required)
- Wallet funded with POL on Polygon Amoy
- Numeric chain-selector for Polygon Amoy fetched from <https://docs.chain.link/ccip/directory> and set in `project.yaml`
- `reserveAddress` in `config.staging.json` set to the deployed `JouleCreditReserve` address on Amoy

## ABI sharing

`JouleCreditReserve.json` ABI lives in `joule-credits/artifacts/contracts/JouleCreditReserve.sol/JouleCreditReserve.json` after `npx hardhat compile`. Copy it manually to `abis/JouleCreditReserve.json` whenever the interface changes:

```bash
cp ../joule-credits/artifacts/contracts/JouleCreditReserve.sol/JouleCreditReserve.json ./abis/
```

A future iteration may automate this via GitHub Actions or an npm-published `@data-joule/contract-abis` package.

## Running tests

```bash
cd por-workflow
bun install      # or: npm install
bun test         # or: npx vitest run
```

The bounds parity test lives in `joule-credits/test/bounds-parity.test.js` and verifies that the `KWH_MIN/KWH_MAX/TIER_*/DURATION_*` sentinels match between `source.js` and `compute.ts`.

## Deployment (Polygon Amoy)

Per the spec's Approval Protocol, deployment commands are run by the operator, not by automation.

```bash
# Local validation (no on-chain writes)
cre workflow simulate por-workflow --target staging-settings

# Simulate with broadcast (uses MockKeystoneForwarder on Amoy)
cre workflow simulate por-workflow --target staging-settings --broadcast

# Deploy (workflow starts PAUSED)
cre workflow deploy por-workflow --target staging-settings

# Activate
cre workflow activate por-workflow --target staging-settings
```

After activation, observe the first `AttestationUpdated` event on the `JouleCreditReserve` contract address — this confirms the end-to-end pipeline.

## KeystoneForwarder addresses (Polygon Amoy)

- Production: `0x76c9cf548b4179F8901cda1f8623568b58215E62`
- Mock (simulate --broadcast): `0x3675a5eb2286a3f87e8278fc66edf458a2e3bb74`

These are passed to `JouleCreditReserve`'s constructor at deploy time — verify against current CRE docs before deploying.
