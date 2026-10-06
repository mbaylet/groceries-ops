/** Lowercase, ligatures expanded, accents stripped, punctuation → single spaces. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Naive French singular: poireaux → poireau, pommes → pomme. Short words untouched. */
export function singularize(w: string): string {
  if (w.length <= 3) return w;
  if (/(eau|eu|ou)x$/.test(w)) return w.slice(0, -1);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokens(s: string): string[] {
  return normalizeText(s).split(' ').filter(Boolean).map(singularize);
}

/** True when needle's tokens appear contiguously in haystack's tokens (whole words only). */
export function containsPhrase(haystack: string, needle: string): boolean {
  const h = tokens(haystack);
  const n = tokens(needle);
  if (n.length === 0) return false;
  for (let i = 0; i <= h.length - n.length; i++) {
    if (n.every((t, j) => h[i + j] === t)) return true;
  }
  return false;
}

export function findExclusions(lines: string[], exclusions: string[]): { exclusion: string; line: string }[] {
  const hits: { exclusion: string; line: string }[] = [];
  for (const line of lines) {
    for (const exclusion of exclusions) {
      if (containsPhrase(line, exclusion)) hits.push({ exclusion, line });
    }
  }
  return hits;
}
