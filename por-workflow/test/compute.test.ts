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
    // A single out-of-bounds event is a 100% drop rate → hard-fail.
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

  // ── Tolerant-attestor behavior ──────────────────────────────────────────
  // A single malformed or zero-reduction event must never freeze the reserve.
  // Zero-reduction events are legitimate (a DR event that achieved no
  // curtailment) and contribute 0. Malformed events are skipped, but if too
  // many drop, that signals real corruption and we hard-fail.

  it("treats kwh_reduced=0 as a valid no-curtailment event contributing 0", () => {
    const events = [
      { event_name: "ons-tier1-1780261357", kwh_reduced: 0, kwh_scaled: null, completed_at: 1780263523 },
      { event_name: "ons-tier1-1779989787", kwh_reduced: 0.000320714, kwh_scaled: "320714", completed_at: 1779991599 },
    ];
    // zero event contributes 0 but is still a valid, counted event
    expect(sumKwhScaled(events)).toEqual({ total: 320714, count: 2 });
  });

  it("drops a positive-reduction event missing kwh_scaled, keeps the rest (below drop threshold)", () => {
    const events = [
      { event_name: "ons-tier1-1780074202", kwh_reduced: 0.000477, kwh_scaled: null, completed_at: 1 }, // DROP
      { event_name: "ons-tier1-1779989787", kwh_reduced: 0.000320714, kwh_scaled: "320714", completed_at: 2 },
      { event_name: "ons-tier1-1779888851", kwh_reduced: 0.000258119, kwh_scaled: "258119", completed_at: 3 },
      { event_name: "ons-tier1-1779814949", kwh_reduced: 0.00036282, kwh_scaled: "362820", completed_at: 4 },
      { event_name: "ons-tier1-1779730537", kwh_reduced: 0.000415142, kwh_scaled: "415142", completed_at: 5 },
      { event_name: "ons-tier1-1779730538", kwh_reduced: 0.0001, kwh_scaled: "100000", completed_at: 6 },
    ];
    // 5 valid (320714+258119+362820+415142+100000=1456795), 1 dropped (1/6 = 16.7% < 20%)
    expect(sumKwhScaled(events)).toEqual({ total: 1456795, count: 5 });
  });

  it("matches the live /api/events/log shape: zero events valid, one positive-null dropped", () => {
    const live = [
      { event_name: "ons-tier1-1780261357", kwh_reduced: 0, kwh_scaled: null, completed_at: 1780263523 },
      { event_name: "ons-tier1-1780173335", kwh_reduced: 0, kwh_scaled: null, completed_at: 1780177039 },
      { event_name: "ons-tier1-1780074202", kwh_reduced: 0.0004779279279279303, kwh_scaled: null, completed_at: 1780076143 }, // DROP
      { event_name: "ons-tier1-1779989787", kwh_reduced: 0.0003207142857142937, kwh_scaled: "320714", completed_at: 1779991599 },
      { event_name: "ons-tier1-1779888851", kwh_reduced: 0.0002581196581196625, kwh_scaled: "258119", completed_at: 1779890657 },
      { event_name: "ons-tier1-1779814949", kwh_reduced: 0.0003628205128205142, kwh_scaled: "362820", completed_at: 1779816768 },
      { event_name: "ons-tier1-1779730537", kwh_reduced: 0.000415142857142853, kwh_scaled: "415142", completed_at: 1779732359 },
    ];
    // 6 valid (2 zero + 4 contributing), 1 dropped (1/7 = 14.3% < 20%)
    // total = 320714 + 258119 + 362820 + 415142 = 1356795
    expect(sumKwhScaled(live)).toEqual({ total: 1356795, count: 6 });
  });

  it("deduplicates events stored under both the legacy and namespaced Redis keys", () => {
    // /api/events/log scans event:report:* and returns each event twice (legacy
    // key + participant-namespaced key). The reserve must count each event ONCE,
    // or it over-attests and the token mints beyond what is backed.
    const dup = [
      { event_name: "ons-tier1-1779989787", kwh_reduced: 0.000320714, kwh_scaled: "320714", completed_at: 1 },
      { event_name: "ons-tier1-1779989787", kwh_reduced: 0.000320714, kwh_scaled: "320714", completed_at: 1 },
      { event_name: "ons-tier1-1779888851", kwh_reduced: 0.000258119, kwh_scaled: "258119", completed_at: 2 },
      { event_name: "ons-tier1-1779888851", kwh_reduced: 0.000258119, kwh_scaled: "258119", completed_at: 2 },
    ];
    // two distinct events, each listed twice → counted once, summed once
    expect(sumKwhScaled(dup)).toEqual({ total: 578833, count: 2 });
  });

  it("when an event appears as both a null and a valid copy, keeps the valid one", () => {
    // A half-completed backfill can leave one key with kwh_scaled and the other
    // null. Dedup must prefer the usable copy so real kWh is not dropped.
    const events = [
      { event_name: "ons-tier1-1780074202", kwh_reduced: 0.000477, kwh_scaled: null, completed_at: 5 },
      { event_name: "ons-tier1-1780074202", kwh_reduced: 0.000477, kwh_scaled: "477000", completed_at: 5 },
    ];
    expect(sumKwhScaled(events)).toEqual({ total: 477000, count: 1 });
  });

  it("hard-fails when the drop rate exceeds 20% (signals corruption)", () => {
    const events = [
      { event_name: "a", kwh_reduced: 0.000477, kwh_scaled: null, completed_at: 1 }, // DROP
      { event_name: "b", kwh_reduced: 0.000477, kwh_scaled: null, completed_at: 2 }, // DROP
      { event_name: "c", kwh_reduced: 0.0001, kwh_scaled: "100000", completed_at: 3 },
    ];
    // 2 dropped / 3 = 67% > 20%
    expect(() => sumKwhScaled(events)).toThrow(/drop rate/i);
  });
});
