# FleetCheck: quarterly random selection (Part 4, Option A)

Picks a share of a company's active vehicles for a surprise inspection each quarter.
Every vehicle has an equal chance, an auditor can replay the result from the stored
inputs, and running it twice for the same company and quarter returns the first
selection instead of making a second one.

## Run it

Requires Node.js 20 or newer.

```bash
npm install
npm test             # 36 tests (vitest), about 4 seconds
npm run typecheck    # tsc --noEmit, strict mode

npm run demo -- 200000 25 2026-Q4                                   # 200k vehicles, 25%
npm run demo -- 20 25 2026-Q4 --out examples/selection-record.json  # write an evidence record
npm run verify -- examples/selection-record.json                    # what an auditor runs
```

## How it works

```
src/selection.ts   pure algorithm: selectVehicles(), sampleSize()
src/service.ts     SelectionService.run() (idempotent) and verifySelection() (auditor replay)
src/inMemory.ts    in-memory repository and vehicle source for tests and the demo
src/cli.ts         demo and verify commands
sql/schema.sql     how the repository maps onto PostgreSQL (unique constraint, RLS, no UPDATE/DELETE)
```

1. **Equal chance.** Each vehicle gets a key `HMAC-SHA256(seed, version | company | quarter | vehicleId)`.
   The `k` vehicles with the smallest keys are picked. Taking the k smallest of n independent
   uniform values selects every k-subset with equal probability, so each vehicle's chance is k/n.
   A chi-square test over 20,000 seeded runs checks this.
2. **Reproducible.** The seed (32 random bytes) is generated once and stored with the selection,
   together with a snapshot of the eligible vehicle IDs, the percentage, the algorithm version, a
   hash of the inputs and a SHA-256 commitment to the seed. `verifySelection()` replays all of it
   and compares every output field. Because each key depends only on the vehicle's own ID, the
   order in which vehicles are loaded cannot change the result.
3. **Never a second selection.** `run()` returns the stored selection if one exists. The final
   guard is the storage layer: `insertIfAbsent` is atomic (in PostgreSQL, `UNIQUE (company_id, quarter)`
   plus `INSERT ... ON CONFLICT DO NOTHING`), so two pods racing still store one selection. A rerun
   with a *different* percentage is refused with `SelectionConflictError` rather than silently ignored.
4. **Last quarter's picks stay eligible.** The algorithm takes no history as input; a test checks that
   Q4's pick equals a fresh pick over the full fleet.
5. **Rounding.** `k = ceil(n × p / 100)` in integer basis-point maths, so 25% of 3 vehicles is 1, not 0.
   This is an assumption to confirm with the client (Part 1, question 1).

## Complexity

With n eligible vehicles and k selected:

- **Time:** O(n log n). n HMAC computations (O(n)) plus one sort. 200,000 vehicles take about 1 second
  on a laptop-class machine, most of it in HMAC. Verification costs the same.
- **Space:** O(n) for the keys and the eligible snapshot. Could drop to O(k) extra memory with a bounded
  max-heap (O(n log k) time), but at 200,000 vehicles memory is a few tens of MB, so the simpler sort wins.
- **Storage:** O(n) per selection for the eligible snapshot. That is deliberate: without the snapshot,
  the auditor cannot know which vehicles were eligible on the day.

## Edge case the brief does not mention

**Where the seed comes from decides whether the pick is a surprise and whether it is fair.**

- If the seed were derived from public inputs only (say, company ID and quarter), the selection
  would be fully reproducible, but anyone with the code could compute next quarter's pick today,
  and the "surprise" inspection would no longer be a surprise.
- If the seed is purely random with no controls, an insider could run the selection many times
  and keep the result they like. That is reproducible, yet not provably fair.

What this code does: a fresh 32-byte random seed per selection, stored with a SHA-256 commitment;
one selection per company per quarter enforced by the database; selections never updated or
deleted; seed visible only to ops and auditors. For stronger proof in production I would derive
the seed from a public randomness beacon round (for example drand) that is fixed *after* the
eligible snapshot is frozen, so nobody, including us, can choose or predict the outcome.

Other edges handled: an empty fleet selects 0; duplicate or empty vehicle IDs are rejected; a fleet
that changes after the selection does not change it (snapshot); the quarter format is validated;
records carry an algorithm version so a future change cannot silently break old audits.

## Not included (would come next)

- A real PostgreSQL repository and an integration test against Postgres (Testcontainers).
- Storing the eligible snapshot in S3 (gzip plus its hash in the row) for very large fleets.
- The beacon-based seed source described above.
