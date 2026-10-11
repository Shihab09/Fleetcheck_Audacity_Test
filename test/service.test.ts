import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemorySelectionRepository, InMemoryVehicleSource } from "../src/inMemory.js";
import { selectVehicles } from "../src/selection.js";
import { SelectionConflictError, SelectionService, verifySelection } from "../src/service.js";

const fleet = (n: number) => Array.from({ length: n }, (_, i) => `veh-${i + 1}`);
const cmd = { companyId: "acme", quarter: "2026-Q4", percentage: 25, actor: "ops-1" };

function setup(seeds: string[] = []) {
  const repo = new InMemorySelectionRepository();
  const vehicles = new InMemoryVehicleSource();
  vehicles.set("acme", fleet(200));
  vehicles.set("globex", fleet(80));
  let i = 0;
  const seedSource = vi.fn(() => seeds[i++] ?? createHash("sha256").update(`seed-${i}`).digest("hex"));
  const service = new SelectionService(repo, vehicles, seedSource, () => new Date("2026-10-01T00:00:00Z"));
  return { repo, vehicles, seedSource, service };
}

describe("SelectionService.run", () => {
  it("running twice for the same company and quarter returns the first selection", async () => {
    const { service, repo } = setup();
    const first = await service.run(cmd);
    const second = await service.run(cmd);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record).toEqual(first.record);
    expect(repo.count()).toBe(1);
  });

  it("concurrent runs still produce exactly one selection", async () => {
    const { service, repo } = setup();
    const results = await Promise.all(Array.from({ length: 10 }, () => service.run(cmd)));
    expect(new Set(results.map((r) => r.record.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(repo.count()).toBe(1);
  });

  it("keeps the original selection when the fleet changes after it was made", async () => {
    const { service, vehicles } = setup();
    const first = await service.run(cmd);
    vehicles.set("acme", fleet(500));
    const again = await service.run(cmd);
    expect(again.record.selectedVehicleIds).toEqual(first.record.selectedVehicleIds);
    expect(again.record.eligibleCount).toBe(200);
  });

  it("refuses a second run with a different percentage instead of silently ignoring it", async () => {
    const { service } = setup();
    await service.run(cmd);
    await expect(service.run({ ...cmd, percentage: 50 })).rejects.toThrow(SelectionConflictError);
  });

  it("keeps companies and quarters independent", async () => {
    const { service, repo } = setup();
    const a = await service.run(cmd);
    const b = await service.run({ ...cmd, companyId: "globex" });
    const c = await service.run({ ...cmd, quarter: "2027-Q1" });
    expect(new Set([a.record.id, b.record.id, c.record.id]).size).toBe(3);
    expect(b.record.eligibleCount).toBe(80);
    expect(repo.count()).toBe(3);
  });

  it("does not exclude vehicles picked last quarter", async () => {
    const q3Seed = createHash("sha256").update("q3").digest("hex");
    const q4Seed = createHash("sha256").update("q4").digest("hex");
    const { service } = setup([q3Seed, q4Seed]);
    const q3 = await service.run({ ...cmd, quarter: "2026-Q3" });
    const q4 = await service.run(cmd);

    // Q4 equals a fresh pick over the FULL fleet: history plays no part.
    const fresh = selectVehicles({ companyId: "acme", quarter: "2026-Q4", percentage: 25, vehicleIds: fleet(200), seed: q4Seed });
    expect(q4.record.selectedVehicleIds).toEqual(fresh.selectedVehicleIds);
    expect(q4.record.eligibleVehicleIds).toEqual(expect.arrayContaining(q3.record.selectedVehicleIds));
    // With 50 of 200 picked twice, some overlap is expected (about 12.5 vehicles on average).
    const overlap = q4.record.selectedVehicleIds.filter((id) => q3.record.selectedVehicleIds.includes(id));
    expect(overlap.length).toBeGreaterThan(0);
  });
});

describe("verifySelection (what an auditor runs)", () => {
  it("confirms an untouched record", async () => {
    const { service } = setup();
    const { record } = await service.run(cmd);
    expect(verifySelection(record)).toEqual({ ok: true, problems: [] });
  });

  it("survives a JSON round trip, which is how the evidence bundle is shipped", async () => {
    const { service } = setup();
    const { record } = await service.run(cmd);
    expect(verifySelection(JSON.parse(JSON.stringify(record))).ok).toBe(true);
  });

  it.each([
    ["a swapped selected vehicle", (r: any) => { r.selectedVehicleIds[0] = r.eligibleVehicleIds.find((id: string) => !r.selectedVehicleIds.includes(id)); }, "selectedVehicleIds"],
    ["a changed seed", (r: any) => { r.seed = createHash("sha256").update("forged").digest("hex"); }, "seedCommitment"],
    ["a vehicle removed from the eligible snapshot", (r: any) => { r.eligibleVehicleIds.pop(); }, "inputHash"],
    ["a changed percentage", (r: any) => { r.percentage = 30; }, "inputHash"],
  ])("detects %s", async (_label, tamper, field) => {
    const { service } = setup();
    const { record } = await service.run(cmd);
    const forged = structuredClone(record);
    tamper(forged);
    const report = verifySelection(forged);
    expect(report.ok).toBe(false);
    expect(report.problems.join(" ")).toContain(field);
  });

  it("refuses to verify a record made by an unknown algorithm version", async () => {
    const { service } = setup();
    const { record } = await service.run(cmd);
    const report = verifySelection({ ...record, algorithmVersion: "something-else" });
    expect(report.ok).toBe(false);
  });
});
