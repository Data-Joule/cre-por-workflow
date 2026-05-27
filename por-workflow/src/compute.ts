import { z } from "zod";

// ── Validation bounds — mirrored in joule-credits/functions/source.js
//    Bounds parity is enforced by test/bounds-parity.test.js in joule-credits.
//    Do not edit one file without the other.
export const KWH_MAX = 100;       // BOUNDS_PARITY:kwh_reduced_max
export const KWH_MIN = 0;         // BOUNDS_PARITY:kwh_reduced_min
export const TIER_MIN = 1;        // BOUNDS_PARITY:tier_min
export const TIER_MAX = 4;        // BOUNDS_PARITY:tier_max
export const DURATION_MIN = 30;   // BOUNDS_PARITY:duration_s_min
export const DURATION_MAX = 3600; // BOUNDS_PARITY:duration_s_max

const eventSchema = z.object({
  event_name:   z.string(),
  kwh_reduced:  z.number().gt(KWH_MIN).lte(KWH_MAX),
  kwh_scaled:   z.string().regex(/^\d+$/),
  completed_at: z.number(),
});

export type Attestation = { total: string; count: number };

/**
 * Deterministically compute the cumulative attestation from /api/events/log.
 *
 * Each DON node runs this independently against the same URL. Output is
 * aggregated by consensus (ConsensusAggregationByFields, both fields
 * "identical"). Any divergence between nodes causes consensus to fail and
 * the workflow exits without writing — the conservative, correct behavior
 * for a reserve ceiling.
 *
 * All math uses BigInt — no floating-point accumulation in this path. The
 * canonical kwh_scaled string is computed once at ingest in data-joule.com
 * and consumed verbatim by both this workflow and source.js.
 */
export const computeAttestation = (
  url: string,
  fetcher: (u: string) => { ok: boolean; status: number; json: () => unknown[] } = defaultFetcher,
): Attestation => {
  const response = fetcher(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  const raw = response.json();
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
  return { total: total.toString(), count };
};

// Default fetcher used in production — replaced in tests with a fixture loader.
// At CRE runtime, this is the fetch() exposed by HTTPClientCapability.
function defaultFetcher(url: string): { ok: boolean; status: number; json: () => unknown[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchFn = (globalThis as any).fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("fetch is not available in this runtime");
  }
  return fetchFn(url) as { ok: boolean; status: number; json: () => unknown[] };
}
