import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InvalidInputError } from "../src/quarter.js";
import { sampleSize, selectVehicles, seedCommitment } from "../src/selection.js";

const seedFor = (label: string) => createHash("sha256").update(label).digest("hex");
const fleet = (n: number) => Array.from({ length: n }, (_, i) => `veh-${i + 1}`);
const base = { companyId: "acme", quarter: "2026-Q4", percentage: 25, seed: seedFor("fixed") };

function shuffled<T>(xs: T[], salt: string): T[] {
  // Deterministic shuffle so the test never flakes.
  return [...xs].sort((a, b) =>
    createHash("md5").update(salt + String(a)).digest("hex") <
    createHash("md5").update(salt + String(b)).digest("hex") ? -1 : 1,
  );
}

describe("sampleSize", () => {
  it.each([
    [20, 25, 5],
    [200_000, 25, 50_000],
    [3, 25, 1], // rounds up: a small fleet still gets a surprise inspection
    [1, 1, 1],
    [0, 25, 0], // empty fleet: nothing to pick
    [7, 12.5, 1],
    [10, 100, 10],
    [101, 33.33, 34],
  ])("%i vehicles at %d%% -> %i", (n, pct, k) => {
    expect(sampleSize(n, pct)).toBe(k);
  });

  it.each([0, -5, 100.01, Number.NaN, Number.POSITIVE_INFINITY, 12.345])("rejects percentage %d", (pct) => {
    expect(() => sampleSize(10, pct)).toThrow(InvalidInputError);
  });
});

describe("selectVehicles", () => {
  it("picks the right number of distinct, eligible vehicles", () => {
    const ids = fleet(20);
    const r = selectVehicles({ ...base, vehicleIds: ids });
    expect(r.selectedCount).toBe(5);
    expect(new Set(r.selectedVehicleIds).size).toBe(5);
    for (const id of r.selectedVehicleIds) expect(ids).toContain(id);
  });

  it("is reproducible: same inputs give the same result, field for field", () => {
    const a = selectVehicles({ ...base, vehicleIds: fleet(500) });
    const b = selectVehicles({ ...base, vehicleIds: fleet(500) });
    expect(b).toEqual(a);
  });

  it("does not depend on the order the vehicles arrive in", () => {
    const ids = fleet(500);
    const a = selectVehicles({ ...base, vehicleIds: ids });
    const b = selectVehicles({ ...base, vehicleIds: shuffled(ids, "x") });
    expect(b.selectedVehicleIds).toEqual(a.selectedVehicleIds);
    expect(b.inputHash).toBe(a.inputHash);
  });

  it("gives a different selection for a different seed, company or quarter", () => {
    const ids = fleet(1000);
    const a = selectVehicles({ ...base, vehicleIds: ids }).selectedVehicleIds;
    expect(selectVehicles({ ...base, vehicleIds: ids, seed: seedFor("other") }).selectedVehicleIds).not.toEqual(a);
    expect(selectVehicles({ ...base, vehicleIds: ids, companyId: "globex" }).selectedVehicleIds).not.toEqual(a);
    expect(selectVehicles({ ...base, vehicleIds: ids, quarter: "2027-Q1" }).selectedVehicleIds).not.toEqual(a);
  });

  it("records a commitment to the seed and a hash of the inputs", () => {
    const r = selectVehicles({ ...base, vehicleIds: fleet(10) });
    expect(r.seedCommitment).toBe(seedCommitment(base.seed));
    expect(r.inputHash).toMatch(/^[0-9a-f]{64}$/);
    const other = selectVehicles({ ...base, vehicleIds: fleet(11) });
    expect(other.inputHash).not.toBe(r.inputHash);
  });

  it("handles an empty fleet", () => {
    const r = selectVehicles({ ...base, vehicleIds: [] });
    expect(r.selectedVehicleIds).toEqual([]);
    expect(r.eligibleCount).toBe(0);
  });

  it("gives every vehicle an equal chance (chi-square over 20,000 seeded runs)", () => {
    const ids = fleet(20);
    const runs = 20_000;
    const counts = new Map(ids.map((id) => [id, 0]));
    for (let t = 0; t < runs; t++) {
      for (const id of selectVehicles({ ...base, vehicleIds: ids, seed: seedFor(`trial-${t}`) }).selectedVehicleIds) {
        counts.set(id, counts.get(id)! + 1);
      }
    }
    const expected = (runs * 5) / 20; // 5,000 picks per vehicle
    const chi2 = [...counts.values()].reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
    // 19 degrees of freedom; critical value at p = 0.001 is 43.82.
    // Seeds are fixed, so this is deterministic: it passes or fails the same way every time.
    expect(chi2).toBeLessThan(43.82);
  });

  it("selects from 200,000 vehicles quickly", () => {
    const ids = fleet(200_000);
    const t0 = performance.now();
    const r = selectVehicles({ ...base, vehicleIds: ids });
    const ms = performance.now() - t0;
    expect(r.selectedCount).toBe(50_000);
    expect(new Set(r.selectedVehicleIds).size).toBe(50_000);
    expect(ms).toBeLessThan(5_000);
  });

  it("rejects bad input instead of guessing", () => {
    expect(() => selectVehicles({ ...base, vehicleIds: ["a", "b", "a"] })).toThrow(/duplicate/);
    expect(() => selectVehicles({ ...base, vehicleIds: ["a", ""] })).toThrow(/non-empty/);
    expect(() => selectVehicles({ ...base, vehicleIds: ["a"], seed: "abc" })).toThrow(/seed/);
    expect(() => selectVehicles({ ...base, vehicleIds: ["a"], quarter: "2026-Q5" })).toThrow(/quarter/);
    expect(() => selectVehicles({ ...base, vehicleIds: ["a"], quarter: "Q4 2026" })).toThrow(/quarter/);
    expect(() => selectVehicles({ ...base, vehicleIds: ["a"], companyId: "" })).toThrow(/companyId/);
  });
});
