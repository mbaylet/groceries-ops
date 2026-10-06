const RE = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** ISO-8601 duration ("PT2H15M") → whole minutes (seconds round up). */
export function parseIsoDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = RE.exec(value.trim());
  if (!m || m.slice(1).every((g) => g === undefined)) return undefined;
  const [d, h, min, s] = m.slice(1).map((g) => (g === undefined ? 0 : Number(g)));
  return d * 1440 + h * 60 + min + Math.ceil(s / 60);
}
