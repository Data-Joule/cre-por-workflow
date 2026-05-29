import { z } from "zod";

// ── Validation bounds — mirrored in joule-credits/functions/source.js
//    Bounds parity is enforced by joule-credits/test/bounds-parity.test.js.
//    Do not edit one file without the other.
export const KWH_MAX = 100;       // BOUNDS_PARITY:kwh_reduced_max
export const KWH_MIN = 0;         // BOUNDS_PARITY:kwh_reduced_min
export const TIER_MIN = 1;        // BOUNDS_PARITY:tier_min
export const TIER_MAX = 4;        // BOUNDS_PARITY:tier_max
export const DURATION_MIN = 30;   // BOUNDS_PARITY:duration_s_min
export const DURATION_MAX = 3600; // BOUNDS_PARITY:duration_s_max

const eventSchema = z.object({
  event_name: z.string(),
  kwh_reduced: z.number().gt(KWH_MIN).lte(KWH_MAX),
  kwh_scaled: z.string().regex(/^\d+$/),
  completed_at: z.number(),
});

// total is the cumulative kwh_scaled (kwh * 1e9). Carried as a JS number for the
// consensus layer (median aggregation requires NumericType). The sum is computed
// in BigInt for exactness, then narrowed — safe while the total stays under
// Number.MAX_SAFE_INTEGER (2^53 ≈ 9.0e15, i.e. ~9 billion kWh). sumKwhScaled
// throws if that ceiling is ever approached, signalling a needed migration to a
// bigint-safe consensus encoding.
export type Attestation = { total: number; count: number };

/**
 * Deterministically sum kwh_scaled across all events. Pure function — each DON
 * node runs it on the same /api/events/log payload and the results are reconciled
 * by consensus. No floating-point: the canonical kwh_scaled string (computed once
 * at ingest in data-joule.com) is summed via BigInt.
 */
export const sumKwhScaled = (raw: unknown): Attestation => {
  if (!Array.isArray(raw)) {
    throw new Error("Expected JSON array from /api/events/log");
  }
  let total = 0n;
  let count = 0;
  for (const item of raw) {
    const event = eventSchema.parse(item);
    total += BigInt(event.kwh_scaled);
    count++;
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `total ${total} exceeds MAX_SAFE_INTEGER — migrate consensus to bigint-safe encoding`,
    );
  }
  return { total: Number(total), count };
};
