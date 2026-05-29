import { describe, it, expect } from "vitest";
import { sumKwhScaled } from "../src/compute";
import happyEvents from "./fixtures/events-log-happy.json" with { type: "json" };
import emptyEvents from "./fixtures/events-log-empty.json" with { type: "json" };
import badSchemaEvents from "./fixtures/events-log-bad-schema.json" with { type: "json" };
import monotonicDecrease from "./fixtures/events-log-monotonic-decrease.json" with { type: "json" };
import multiSource from "./fixtures/events-log-multi-source.json" with { type: "json" };

describe("sumKwhScaled", () => {
  it("sums kwh_scaled across the happy-path fixture", () => {
    // 375000 + 750000 + 350000 + 1833000 + 3250000 = 6558000
    expect(sumKwhScaled(happyEvents)).toEqual({ total: 6558000, count: 5 });
  });

  it("returns total=0 count=0 for empty array", () => {
    expect(sumKwhScaled(emptyEvents)).toEqual({ total: 0, count: 0 });
  });

  it("throws on bad schema (zod validation)", () => {
    expect(() => sumKwhScaled(badSchemaEvents)).toThrow();
  });

  it("aggregates across multiple sources (ons + hilo + grid)", () => {
    // 667000 + 350000 + 1667000 = 2684000
    expect(sumKwhScaled(multiSource)).toEqual({ total: 2684000, count: 3 });
  });

  it("idempotency: running twice on the same data yields the same result", () => {
    expect(sumKwhScaled(happyEvents)).toEqual(sumKwhScaled(happyEvents));
  });

  it("monotonic-decrease scenario: fewer events yield a lower total", () => {
    const prior = sumKwhScaled(happyEvents);
    const after = sumKwhScaled(monotonicDecrease);
    expect(after.total).toBeLessThan(prior.total);
    // The on-chain monotonicity gate (newTotal > current) catches this in main.ts
    // before any write — the test confirms the computation surfaces the decrease.
  });

  it("rejects non-array payload", () => {
    expect(() => sumKwhScaled({ not: "an array" })).toThrow(/array/i);
  });

  it("rejects kwh_reduced outside (0, 100] bound", () => {
    expect(() =>
      sumKwhScaled([
        { event_name: "grid-tier1-1715515290", kwh_reduced: 150, kwh_scaled: "150000000000", completed_at: 1715515480 },
      ]),
    ).toThrow();
    expect(() =>
      sumKwhScaled([
        { event_name: "grid-tier1-1715515290", kwh_reduced: -1, kwh_scaled: "0", completed_at: 1715515480 },
      ]),
    ).toThrow();
  });
});
