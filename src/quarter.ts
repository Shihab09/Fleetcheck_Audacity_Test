/** A calendar quarter written as "YYYY-Qn", for example "2026-Q4". */
export type Quarter = `${number}-Q${1 | 2 | 3 | 4}`;

const QUARTER_RE = /^(\d{4})-Q([1-4])$/;

export function parseQuarter(value: string): Quarter {
  const m = QUARTER_RE.exec(value);
  if (!m) {
    throw new InvalidInputError(`quarter must look like "2026-Q4", got "${value}"`);
  }
  return value as Quarter;
}

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}
