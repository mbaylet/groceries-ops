import { normalizeText, tokens } from './normalize.ts';

export interface ParsedIngredient {
  raw: string;
  qty?: number;
  unit?: string;
  name: string;
  key: string;
}

interface UnitDef { unit: string; factor: number }

const UNITS: [string[], UnitDef][] = [
  [['g', 'gr', 'gramme', 'grammes'], { unit: 'g', factor: 1 }],
  [['kg', 'kilo', 'kilos', 'kilogramme', 'kilogrammes'], { unit: 'g', factor: 1000 }],
  [['mg'], { unit: 'g', factor: 0.001 }],
  [['ml', 'millilitre', 'millilitres'], { unit: 'ml', factor: 1 }],
  [['cl', 'centilitre', 'centilitres'], { unit: 'ml', factor: 10 }],
  [['dl', 'decilitre', 'decilitres'], { unit: 'ml', factor: 100 }],
  [['l', 'litre', 'litres'], { unit: 'ml', factor: 1000 }],
  [['cuillere a soupe', 'cuilleres a soupe', 'c a soupe', 'c a s', 'cas', 'cs'], { unit: 'cas', factor: 1 }],
  [['cuillere a cafe', 'cuilleres a cafe', 'c a cafe', 'c a c', 'cac', 'cc'], { unit: 'cac', factor: 1 }],
  [['pincee', 'pincees'], { unit: 'pincee', factor: 1 }],
  [['gousse', 'gousses'], { unit: 'gousse', factor: 1 }],
  [['tranche', 'tranches'], { unit: 'tranche', factor: 1 }],
  [['boite', 'boites'], { unit: 'boite', factor: 1 }],
  [['pot', 'pots'], { unit: 'pot', factor: 1 }],
  [['sachet', 'sachets'], { unit: 'sachet', factor: 1 }],
  [['brin', 'brins'], { unit: 'brin', factor: 1 }],
  [['botte', 'bottes'], { unit: 'botte', factor: 1 }],
  [['feuille', 'feuilles'], { unit: 'feuille', factor: 1 }],
  [['verre', 'verres'], { unit: 'verre', factor: 1 }],
  [['poignee', 'poignees'], { unit: 'poignee', factor: 1 }],
  [['morceau', 'morceaux'], { unit: 'morceau', factor: 1 }],
];

// Longest alias first so "cuillere a soupe" wins over "c".
const ALIASES = UNITS.flatMap(([names, def]) => names.map((n) => [n, def] as const)).sort(
  (a, b) => b[0].length - a[0].length,
);

const QTY_RE = /^\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔])(?:\s*(?:à|-)\s*\d+(?:[.,]\d+)?)?\s*/;
const ADJECTIVES = /^(?:(?:petite?s?|grande?s?|gros|grosses?|belles?|beaux?|bonne?s?)\s+)+/;
const ARTICLES = /^(?:de la|de l|des|du|de|d)\s+/;
const FRACTIONS: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 0.33, '⅔': 0.67 };

const round = (x: number) => Math.round(x * 1000) / 1000;

function parseQty(s: string): number {
  const frac = FRACTIONS[s];
  if (frac !== undefined) return frac;
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const simple = /^(\d+)\/(\d+)$/.exec(s);
  if (simple) return Number(simple[1]) / Number(simple[2]);
  return Number(s.replace(',', '.'));
}

/** "1 kg de blanquette de veau" → { qty: 1000, unit: 'g', name: 'blanquette de veau', key: 'blanquette de veau' } */
export function parseIngredientLine(raw: string): ParsedIngredient {
  const cleaned = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const m = QTY_RE.exec(cleaned);
  let qty: number | undefined;
  let rest = cleaned;
  if (m && m[0].trim()) {
    qty = parseQty(m[1]);
    rest = cleaned.slice(m[0].length);
  }
  let n = normalizeText(rest).replace(ADJECTIVES, '');
  let unit: string | undefined;
  // Units only count after a number: "l'oignon" must not read as litres.
  if (qty !== undefined) {
    for (const [alias, def] of ALIASES) {
      if (n === alias || n.startsWith(`${alias} `)) {
        unit = def.unit;
        qty = round(qty * def.factor);
        n = n.slice(alias.length).trim();
        break;
      }
    }
  }
  n = n.replace(ARTICLES, '').replace(ADJECTIVES, '').trim();
  const result: ParsedIngredient = { raw, name: n, key: tokens(n).join(' ') };
  if (qty !== undefined) result.qty = qty;
  if (unit !== undefined) result.unit = unit;
  return result;
}
