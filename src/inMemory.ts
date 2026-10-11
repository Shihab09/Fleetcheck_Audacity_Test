import type { SelectionRecord, SelectionRepository, VehicleSource } from "./service.js";

/** Test and demo double. Map operations are synchronous, so insertIfAbsent is atomic. */
export class InMemorySelectionRepository implements SelectionRepository {
  private readonly rows = new Map<string, SelectionRecord>();

  private static key(companyId: string, quarter: string) {
    return `${companyId}\u0000${quarter}`;
  }

  async find(companyId: string, quarter: string) {
    const row = this.rows.get(InMemorySelectionRepository.key(companyId, quarter));
    return row ? structuredClone(row) : null;
  }

  async insertIfAbsent(record: SelectionRecord) {
    const key = InMemorySelectionRepository.key(record.companyId, record.quarter);
    const existing = this.rows.get(key);
    if (existing) return { record: structuredClone(existing), created: false };
    this.rows.set(key, structuredClone(record));
    return { record: structuredClone(record), created: true };
  }

  count() {
    return this.rows.size;
  }
}

export class InMemoryVehicleSource implements VehicleSource {
  constructor(private readonly fleets: Map<string, string[]> = new Map()) {}

  set(companyId: string, ids: string[]) {
    this.fleets.set(companyId, [...ids]);
  }

  async listActiveVehicleIds(companyId: string) {
    return [...(this.fleets.get(companyId) ?? [])];
  }
}
