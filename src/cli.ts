import { readFileSync, writeFileSync } from "node:fs";
import { InMemorySelectionRepository, InMemoryVehicleSource } from "./inMemory.js";
import { SelectionService, verifySelection, type SelectionRecord } from "./service.js";

// Usage:
//   npx tsx src/cli.ts demo [vehicleCount] [percentage] [quarter] [--out record.json]
//   npx tsx src/cli.ts verify path/to/record.json
async function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  if (outIdx >= 0) argv.splice(outIdx, 2);
  const [cmd = "demo", ...args] = argv;

  if (cmd === "verify") {
    const path = args[0];
    if (!path) throw new Error("usage: verify <record.json>");
    const record = JSON.parse(readFileSync(path, "utf8")) as SelectionRecord;
    const report = verifySelection(record);
    console.log(report.ok ? "VERIFIED: replay matches the stored selection" : "FAILED");
    for (const p of report.problems) console.log(" -", p);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  const n = Number(args[0] ?? 20);
  const pct = Number(args[1] ?? 25);
  const quarter = args[2] ?? "2026-Q4";
  const vehicles = new InMemoryVehicleSource();
  vehicles.set("acme", Array.from({ length: n }, (_, i) => `veh-${String(i + 1).padStart(6, "0")}`));
  const service = new SelectionService(new InMemorySelectionRepository(), vehicles);

  const t0 = performance.now();
  const first = await service.run({ companyId: "acme", quarter, percentage: pct, actor: "demo" });
  const ms = (performance.now() - t0).toFixed(0);
  const second = await service.run({ companyId: "acme", quarter, percentage: pct, actor: "demo" });

  const { eligibleVehicleIds, ...summary } = first.record;
  console.log(JSON.stringify({ ...summary, selectedVehicleIds: summary.selectedVehicleIds.slice(0, 10) }, null, 2));
  console.log(`eligible snapshot: ${eligibleVehicleIds.length} IDs (omitted)`);
  console.log(`selected ${first.record.selectedCount} of ${n} in ${ms} ms`);
  console.log(`second run created a new selection: ${second.created} (same id: ${second.record.id === first.record.id})`);
  console.log(`auditor replay: ${verifySelection(first.record).ok ? "matches" : "MISMATCH"}`);
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(first.record, null, 2) + "\n");
    console.log(`evidence record written to ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
