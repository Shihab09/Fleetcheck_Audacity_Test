import { createHash, createHmac } from "node:crypto";
import { InvalidInputError, parseQuarter, type Quarter } from "./quarter.js";

/**
 * Bump this if the algorithm ever changes. Old records keep their version, so an
 * auditor always replays a selection with the exact algorithm that produced it.
 */
export const ALGORITHM_VERSION = "hmac-sha256-rank-v1";

export interface SelectionInput {
  companyId: string;
  quarter: string;
  /** IDs of the company's eligible (active) vehicles. Order does not matter. */
  vehicleIds: readonly string[];
  /** Share of the fleet to select, 0 < p <= 100, at most 2 decimal places. */
  percentage: number;
  /** 32 random bytes as 64 hex characters, generated once per selection. */
  seed: string;
}

export interface SelectionResult {
  algorithmVersion: string;
  companyId: string;
  quarter: Quarter;
  percentage: number;
  eligibleCount: number;
  selectedCount: number;
  /** Selected vehicle IDs, in rank order (rank 1 first). */
  selectedVehicleIds: string[];
  /** SHA-256 of the canonical inputs (everything except the seed). */
  inputHash: string;
  /** SHA-256 of the seed, safe to publish before the seed itself is revealed. */
  seedCommitment: string;
}

const SEED_RE = /^[0-9a-f]{64}$/;

/** Percentage as basis points (25% -> 2500), so all later maths is integer maths. */
export function toBasisPoints(percentage: number): number {
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
    throw new InvalidInputError(`percentage must be > 0 and <= 100, got ${percentage}`);
  }
  const bp = Math.round(percentage * 100);
  if (Math.abs(bp - percentage * 100) > 1e-6) {
    throw new InvalidInputError(`percentage allows at most 2 decimal places, got ${percentage}`);
  }
  return bp;
}

/**
 * How many vehicles to pick. Rounds UP, so any non-empty fleet gets at least one
 * surprise inspection (25% of 3 vehicles -> 1, not 0). Integer maths only, so
 * 200,000 * 10,000 stays well inside Number.MAX_SAFE_INTEGER.
 */
export function sampleSize(eligibleCount: number, percentage: number): number {
  const bp = toBasisPoints(percentage);
  return Math.floor((eligibleCount * bp + 9999) / 10000);
}

export function seedCommitment(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

function canonicalIds(vehicleIds: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const id of vehicleIds) {
    if (typeof id !== "string" || id.length === 0) {
      throw new InvalidInputError("vehicle IDs must be non-empty strings");
    }
    if (seen.has(id)) {
      throw new InvalidInputError(`duplicate vehicle ID "${id}"`);
    }
    seen.add(id);
  }
  // Code-unit order, not locale order: the same on every machine, forever.
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function computeInputHash(
  companyId: string,
  quarter: string,
  percentage: number,
  sortedIds: readonly string[],
): string {
  const canonical = JSON.stringify({
    algorithmVersion: ALGORITHM_VERSION,
    companyId,
    quarter,
    percentageBasisPoints: toBasisPoints(percentage),
    vehicleIds: sortedIds,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Pure, deterministic selection. Same inputs (including seed) -> same output.
 *
 * Each vehicle gets a sort key = HMAC-SHA256(seed, version | company | quarter | vehicleId).
 * HMAC output behaves like an independent uniform random value per vehicle, and
 * taking the k smallest of n i.i.d. uniform keys picks every k-subset with equal
 * probability, so every vehicle has the same k/n chance. Because the key depends
 * only on the vehicle's own ID, input order cannot change the result.
 */
export function selectVehicles(input: SelectionInput): SelectionResult {
  if (typeof input.companyId !== "string" || input.companyId.length === 0) {
    throw new InvalidInputError("companyId is required");
  }
  const quarter = parseQuarter(input.quarter);
  if (!SEED_RE.test(input.seed)) {
    throw new InvalidInputError("seed must be 64 lowercase hex characters (32 bytes)");
  }
  const ids = canonicalIds(input.vehicleIds);
  const k = sampleSize(ids.length, input.percentage);

  const seedBytes = Buffer.from(input.seed, "hex");
  const prefix = `${ALGORITHM_VERSION}\u0000${input.companyId}\u0000${quarter}\u0000`;

  const keyed = ids.map((id) => ({
    id,
    key: createHmac("sha256", seedBytes).update(prefix + id, "utf8").digest("hex"),
  }));
  // Equal-length lowercase hex compares like the underlying bytes.
  // A tie needs a SHA-256 collision; the ID tie-break just keeps the sort total.
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1));

  return {
    algorithmVersion: ALGORITHM_VERSION,
    companyId: input.companyId,
    quarter,
    percentage: input.percentage,
    eligibleCount: ids.length,
    selectedCount: k,
    selectedVehicleIds: keyed.slice(0, k).map((v) => v.id),
    inputHash: computeInputHash(input.companyId, quarter, input.percentage, ids),
    seedCommitment: seedCommitment(input.seed),
  };
}
//selectedVehicleIds: ids.slice(0, k),
