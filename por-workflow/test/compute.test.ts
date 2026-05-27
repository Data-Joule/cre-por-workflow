import { describe, it, expect } from "vitest";
import { computeAttestation } from "../src/compute";
import happyEvents from "./fixtures/events-log-happy.json" with { type: "json" };
import emptyEvents from "./fixtures/events-log-empty.json" with { type: "json" };
import badSchemaEvents from "./fixtures/events-log-bad-schema.json" with { type: "json" };
import monotonicDecrease from "./fixtures/events-log-monotonic-decrease.json" with { type: "json" };
import multiSource from "./fixtures/events-log-multi-source.json" with { type: "json" };

function mockFetcher(payload: unknown) {
  return (_url: string) => ({
    ok: true,
    status: 200,
    json: () => payload as unknown[],
  });
}

describe("computeAttestation", () => {
  it("sums kwh_scaled across the happy-path fixture", () => {
    const result = computeAttestation("mock://happy", mockFetcher(happyEvents));
    // 375000 + 750000 + 350000 + 1833000 + 3250000 = 6558000
    expect(result.total).toBe("6558000");
    expect(result.count).toBe(5);
  });

  it("returns total=0 count=0 for empty array", () => {
    const result = computeAttestation("mock://empty", mockFetcher(emptyEvents));
    expect(result.total).toBe("0");
    expect(result.count).toBe(0);
  });

  it("throws on bad schema (zod validation)", () => {
    expect(() =>
      computeAttestation("mock://bad", mockFetcher(badSchemaEvents)),
    ).toThrow();
  });

  it("aggregates across multiple sources (ons + hilo + grid)", () => {
    const result = computeAttestation("mock://multi", mockFetcher(multiSource));
    // 667000 + 350000 + 1667000 = 2684000
    expect(result.total).toBe("2684000");
    expect(result.count).toBe(3);
  });

  it("idempotency: running twice on the same data yields the same result", () => {
    const fetcher = mockFetcher(happyEvents);
    const first = computeAttestation("mock://idem", fetcher);
    const second = computeAttestation("mock://idem", fetcher);
    expect(first).toEqual(second);
  });

  it("monotonic-decrease scenario: fewer events than prior state yield lower total", () => {
    const prior = computeAttestation("mock://happy", mockFetcher(happyEvents));
    const after = computeAttestation("mock://shrunk", mockFetcher(monotonicDecrease));
    expect(BigInt(after.total)).toBeLessThan(BigInt(prior.total));
    // The on-chain monotonicity gate (newTotal > currentOnChain) catches this
    // in main.ts before any write — the test confirms the computation
    // surfaces the decrease so the gate has data to act on.
  });

  it("rejects HTTP non-ok response", () => {
    const failingFetcher = (_url: string) => ({
      ok: false,
      status: 503,
      json: () => [],
    });
    expect(() => computeAttestation("mock://fail", failingFetcher)).toThrow(/HTTP 503/);
  });

  it("rejects non-array payload", () => {
    const objectFetcher = (_url: string) => ({
      ok: true,
      status: 200,
      json: () => ({ not: "an array" }) as unknown as unknown[],
    });
    expect(() => computeAttestation("mock://obj", objectFetcher)).toThrow(/array/i);
  });

  it("rejects kwh_reduced outside (0, 100] bound", () => {
    const overMax = [{
      event_name: "grid-tier1-1715515290",
      kwh_reduced: 150,
      kwh_scaled: "150000000000",
      completed_at: 1715515480,
    }];
    expect(() => computeAttestation("mock://over", mockFetcher(overMax))).toThrow();

    const negative = [{
      event_name: "grid-tier1-1715515290",
      kwh_reduced: -1,
      kwh_scaled: "0",
      completed_at: 1715515480,
    }];
    expect(() => computeAttestation("mock://neg", mockFetcher(negative))).toThrow();
  });
});
