// Minimal ABI for the on-chain read. The CRE workflow only needs to read
// attestedKwhTotal() to decide whether a new write is warranted. The write
// itself goes through the KeystoneForwarder → onReport(metadata, report),
// not a direct function call, so updateAttestation is not in this ABI.
export const JouleCreditReserveAbi = [
  {
    type: "function",
    name: "attestedKwhTotal",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
