import { randomBytes, randomUUID } from "node:crypto";
import { parseQuarter } from "./quarter.js";
import { ALGORITHM_VERSION, selectVehicles, type SelectionResult } from "./selection.js";

/** What we store: the result plus everything needed to replay it. */
export interface SelectionRecord extends SelectionResult {
  id: string;
  seed: string;
  /** Snapshot of the eligible set at selection time. Vehicles change; this does not. */
  eligibleVehicleIds: string[];
  createdAt: string;
  createdBy: string;
}

export interface SelectionRepository {
  find(companyId: string, quarter: string): Promise<SelectionRecord | null>;
  /**
   * Insert only if no selection exists for (companyId, quarter); otherwise return
   * the existing one. Must be atomic. In PostgreSQL: a UNIQUE(company_id, quarter)
   * constraint plus INSERT ... ON CONFLICT DO NOTHING, then SELECT (see sql/schema.sql).
   */
  insertIfAbsent(record: SelectionRecord): Promise<{ record: SelectionRecord; created: boolean }>;
}

export interface VehicleSource {
  listActiveVehicleIds(companyId: string): Promise<string[]>;
}

export type SeedSource = () => string;
export const cryptoSeedSource: SeedSource = () => randomBytes(32).toString("hex");

export class SelectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionConflictError";
  }
}

export interface RunSelectionCommand {
  companyId: string;
  quarter: string;
  percentage: number;
  actor: string;
}

export class SelectionService {
  constructor(
    private readonly repo: SelectionRepository,
    private readonly vehicles: VehicleSource,
    private readonly seedSource: SeedSource = cryptoSeedSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Idempotent: the first call for (company, quarter) makes and stores the
   * selection; every later call, including concurrent ones, returns that same
   * stored selection. A later call that asks for a different percentage is
   * refused rather than silently ignored.
   */
  async run(cmd: RunSelectionCommand): Promise<{ record: SelectionRecord; created: boolean }> {
    const quarter = parseQuarter(cmd.quarter);

    const existing = await this.repo.find(cmd.companyId, quarter);
    if (existing) return { record: this.assertSameRequest(existing, cmd), created: false };

    const eligibleVehicleIds = await this.vehicles.listActiveVehicleIds(cmd.companyId);
    const seed = this.seedSource();
    const result = selectVehicles({
      companyId: cmd.companyId,
      quarter,
      vehicleIds: eligibleVehicleIds,
      percentage: cmd.percentage,
      seed,
    });

    const candidate: SelectionRecord = {
      ...result,
      id: randomUUID(),
      seed,
      eligibleVehicleIds: [...eligibleVehicleIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      createdAt: this.now().toISOString(),
      createdBy: cmd.actor,
    };

    // If another request won the race, we get its record back, not ours.
    const outcome = await this.repo.insertIfAbsent(candidate);
    if (!outcome.created) this.assertSameRequest(outcome.record, cmd);
    return outcome;
  }

  private assertSameRequest(record: SelectionRecord, cmd: RunSelectionCommand): SelectionRecord {
    if (record.percentage !== cmd.percentage) {
      throw new SelectionConflictError(
        `a selection for ${cmd.companyId} ${cmd.quarter} already exists at ${record.percentage}%; ` +
          `refusing to make a second one at ${cmd.percentage}%`,
      );
    }
    return record;
  }
}

export interface VerificationReport {
  ok: boolean;
  problems: string[];
}

/**
 * What an auditor runs: replay the stored inputs and compare every output field.
 * Needs nothing from our database except the record itself.
 */
export function verifySelection(record: SelectionRecord): VerificationReport {
  const problems: string[] = [];
  if (record.algorithmVersion !== ALGORITHM_VERSION) {
    problems.push(`record uses ${record.algorithmVersion}; this verifier implements ${ALGORITHM_VERSION}`);
    return { ok: false, problems };
  }
  let replay: SelectionResult;
  try {
    replay = selectVehicles({
      companyId: record.companyId,
      quarter: record.quarter,
      vehicleIds: record.eligibleVehicleIds,
      percentage: record.percentage,
      seed: record.seed,
    });
  } catch (err) {
    return { ok: false, problems: [`replay failed: ${(err as Error).message}`] };
  }
  const checks: Array<[string, unknown, unknown]> = [
    ["seedCommitment", replay.seedCommitment, record.seedCommitment],
    ["inputHash", replay.inputHash, record.inputHash],
    ["eligibleCount", replay.eligibleCount, record.eligibleCount],
    ["selectedCount", replay.selectedCount, record.selectedCount],
    ["selectedVehicleIds", JSON.stringify(replay.selectedVehicleIds), JSON.stringify(record.selectedVehicleIds)],
  ];
  for (const [field, expected, actual] of checks) {
    if (expected !== actual) problems.push(`${field} does not match the replay`);
  }
  return { ok: problems.length === 0, problems };
}
