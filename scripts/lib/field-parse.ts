export type UnitKind = 'kg' | 'l' | 'piece';
export interface UnitPrice { value: number; unit: UnitKind }
export interface Pack { qty: number; unit: 'g' | 'ml' | 'piece' }

const NUM = '(\\d+(?:[.,]\\d+)?)';
const toNum = (s: string) => Number(s.replace(',', '.'));
const round = (x: number) => Math.round(x * 10000) / 10000;

/** Lowercase, accents stripped, thousands separators removed ("1 299,00" → "1299,00"). */
function clean(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/(\d)[\s  ](?=\d{3}\b)/g, '$1');
}

export function parseNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = new RegExp(NUM).exec(clean(v));
  return m ? toNum(m[1]) : undefined;
}

const MEASURE: Record<string, { base: 'g' | 'ml'; factor: number }> = {
  kg: { base: 'g', factor: 1000 },
  g: { base: 'g', factor: 1 },
  l: { base: 'ml', factor: 1000 },
  cl: { base: 'ml', factor: 10 },
  ml: { base: 'ml', factor: 1 },
};

/** "12,50 €/kg", "1,05 €/100g", "0,35 €/pièce", "2,10 € le kg" → price per kg | l | piece. */
export function parseUnitPrice(v: unknown): UnitPrice | undefined {
  if (typeof v !== 'string') return undefined;
  const s = clean(v);
  const m = new RegExp(`${NUM}\\s*(?:€|eur)?\\s*(?:\\/|le|la|par)\\s*${NUM}?\\s*(kg|g|l|cl|ml|piece|pce|unite|u)\\b`).exec(s);
  if (!m) return undefined;
  const price = toNum(m[1]);
  const per = m[2] ? toNum(m[2]) : 1;
  const unit = m[3];
  if (unit === 'piece' || unit === 'pce' || unit === 'unite' || unit === 'u') return { value: round(price / per), unit: 'piece' };
  const def = MEASURE[unit];
  const perBase = per * def.factor; // amount in g or ml
  return { value: round((price / perBase) * 1000), unit: def.base === 'g' ? 'kg' : 'l' };
}

/** "6 x 125 g" → 750 g; "75 cl" → 750 ml; "x12" / "12 oeufs" / "boite de 6" → pieces. */
export function parsePack(v: unknown): Pack | undefined {
  if (typeof v !== 'string') return undefined;
  const s = clean(v);
  const multi = new RegExp(`(\\d+)\\s*x\\s*${NUM}\\s*(kg|g|l|cl|ml)\\b`).exec(s);
  if (multi) {
    const def = MEASURE[multi[3]];
    return { qty: round(Number(multi[1]) * toNum(multi[2]) * def.factor), unit: def.base };
  }
  const single = new RegExp(`${NUM}\\s*(kg|g|l|cl|ml)\\b`).exec(s);
  if (single) {
    const def = MEASURE[single[2]];
    return { qty: round(toNum(single[1]) * def.factor), unit: def.base };
  }
  const count =
    /(?:^|\s)x\s*(\d+)\b/.exec(s) ??
    /(\d+)\s*(?:oeufs?|pieces?|unites?|pots?|sachets?|tranches?|portions?)\b/.exec(s) ??
    /(?:boite|lot|paquet|pack|barquette)\s+de\s+(\d+)\b/.exec(s);
  return count ? { qty: Number(count[1]), unit: 'piece' } : undefined;
}

export function parseBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v !== 'string') return undefined;
  const s = clean(v).trim();
  if (['true', 'yes', 'oui', '1', 'disponible', 'available'].includes(s)) return true;
  if (['false', 'no', 'non', '0', 'indisponible', 'unavailable'].includes(s)) return false;
  return undefined;
}
