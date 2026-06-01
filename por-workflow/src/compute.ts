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

// Largest fraction of events that may fail validation before we treat the batch
// as corrupt and refuse to attest. Below this, malformed events are skipped so a
// single bad event can never freeze the reserve; above it, the divergence is too
// large to be benign and we hard-fail (every DON node fails identically, so no
// write happens and the discrepancy surfaces).
export const MAX_DROP_RATE = 0.2;

// kwh_reduced is allowed to be 0 (a DR event that achieved no curtailment is
// legitimate — it simply contributes nothing). kwh_scaled is required only for
// positive-reduction events; a zero event needs no scaled value. Anything that
// fails this shape is dropped, not thrown.
const eventSchema = z.object({
  event_name: z.string(),
  kwh_reduced: z.number().gte(KWH_MIN).lte(KWH_MAX),
  kwh_scaled: z.string().regex(/^\d+$/).nullish(),
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

  // Dedup by event_name first. /api/events/log scans event:report:* and returns
  // each event twice — once under the legacy key, once under the participant-
  // namespaced key. Summing both would over-attest the reserve (2× the real
  // kWh), letting the token mint beyond what is backed. When duplicate copies
  // disagree, keep the one carrying a usable kwh_scaled (a half-applied backfill
  // can leave one copy null), so real kWh is never dropped to a stale null.
  const byName = new Map<string, z.infer<typeof eventSchema>>();
  let dropped = 0;
  for (const item of raw) {
    const parsed = eventSchema.safeParse(item);
    if (!parsed.success) {
      dropped++;
      continue;
    }
    const event = parsed.data;
    const existing = byName.get(event.event_name);
    if (!existing || (existing.kwh_scaled == null && event.kwh_scaled != null)) {
      byName.set(event.event_name, event);
    }
  }

  let total = 0n;
  let valid = 0;
  for (const event of byName.values()) {
    if (event.kwh_reduced === KWH_MIN) {
      // No-curtailment event: valid, but contributes nothing.
      valid++;
      continue;
    }
    if (event.kwh_scaled == null) {
      // Positive reduction with no canonical scaled value — a producer defect.
      // Drop it rather than guess; the drop-rate guard catches systemic failure.
      dropped++;
      continue;
    }
    total += BigInt(event.kwh_scaled);
    valid++;
  }

  const seen = valid + dropped;
  if (dropped > 0 && dropped / seen > MAX_DROP_RATE) {
    throw new Error(
      `Drop rate ${dropped}/${seen} exceeds ${MAX_DROP_RATE * 100}% — refusing to attest. ` +
        `Likely data corruption or producer schema drift; manual investigation required.`,
    );
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `total ${total} exceeds MAX_SAFE_INTEGER — migrate consensus to bigint-safe encoding`,
    );
  }
  return { total: Number(total), count: valid };
};
