const DAY_MS = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Local calendar date as YYYY-MM-DD. */
export function today(): string {
  return new Date().toLocaleDateString('sv-SE');
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utc(s));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

export function addDays(date: string, n: number): string {
  return new Date(utc(date) + n * DAY_MS).toISOString().slice(0, 10);
}
