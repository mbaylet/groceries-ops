import { addDays, daysBetween } from './dates.ts';
import { tokens } from './normalize.ts';
import { paths } from './paths.ts';
import { readYaml, writeYaml } from './yaml-io.ts';

export type PurchaseStatus = 'confirmed' | 'pending';
export type HabitMode = 'auto' | 'ask' | 'track';
export interface Purchase { date: string; status: PurchaseStatus }
export interface Habit {
  key: string;
  name: string;
  ean?: string;
  purchases: Purchase[];
  interval_days?: number;
  interval_override?: number;
  /** auto: added when due · ask: asked when due · track: learned from store history, never asked until promoted */
  mode: HabitMode;
  last_asked?: string;
  declines_in_row: number;
}
export interface HabitsFile { habits: Habit[] }
export interface ItemRef { name: string; ean?: string }
export interface Order { date: string; items: ItemRef[] }

const DUE_RATIO = 0.85;
const PENDING_TTL_DAYS = 10;
const PENDING_MATCH_DAYS = 7;
const WIDEN_AFTER_DECLINES = 3;
const nameKey = (name: string) => `name:${tokens(name).join(' ')}`;

export const loadHabits = (): HabitsFile => readYaml<HabitsFile>(paths.habits(), { habits: [] });
export const saveHabits = (f: HabitsFile): void => writeYaml(paths.habits(), f);

export function habitKey(item: ItemRef): string {
  return item.ean ? `ean:${item.ean}` : nameKey(item.name);
}

export function findHabit(f: HabitsFile, item: ItemRef): Habit | undefined {
  const key = habitKey(item);
  return (
    f.habits.find((h) => h.key === key) ??
    (item.ean ? f.habits.find((h) => h.ean === item.ean) : undefined) ??
    f.habits.find((h) => nameKey(h.name) === nameKey(item.name))
  );
}

function getOrCreate(f: HabitsFile, item: ItemRef, mode: HabitMode): { habit: Habit; created: boolean } {
  const found = findHabit(f, item);
  if (found) {
    if (item.ean && !found.ean) found.ean = item.ean;
    return { habit: found, created: false };
  }
  const habit: Habit = { key: habitKey(item), name: item.name, purchases: [], mode, declines_in_row: 0 };
  if (item.ean) habit.ean = item.ean;
  f.habits.push(habit);
  return { habit, created: true };
}

export function medianInterval(dates: string[]): number | undefined {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length < 2) return undefined;
  const gaps = sorted.slice(1).map((d, i) => daysBetween(sorted[i], d)).sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
}

export const effectiveInterval = (h: Habit): number | undefined => h.interval_override ?? h.interval_days;

export function lastPurchase(h: Habit): string | undefined {
  return h.purchases.map((p) => p.date).sort().pop();
}

export function nextDue(h: Habit): string | undefined {
  const eff = effectiveInterval(h);
  const last = lastPurchase(h);
  return eff && last ? addDays(last, Math.ceil(DUE_RATIO * eff)) : undefined;
}

export function recompute(h: Habit): void {
  h.purchases.sort((a, b) => a.date.localeCompare(b.date));
  const interval = medianInterval(h.purchases.filter((p) => p.status === 'confirmed').map((p) => p.date));
  if (interval === undefined) delete h.interval_days;
  else h.interval_days = interval;
}

export function isDue(h: Habit, today: string): boolean {
  const eff = effectiveInterval(h);
  const last = lastPurchase(h);
  if (!eff || !last || h.last_asked === today) return false;
  return daysBetween(last, today) >= DUE_RATIO * eff;
}

/** auto only for ~weekly items bought in at least 3 of the last 4 weeks. */
export function proposeMode(h: Habit, today: string): 'auto' | 'ask' {
  const eff = effectiveInterval(h);
  if (!eff || eff < 5 || eff > 9) return 'ask';
  const confirmed = h.purchases.filter((p) => p.status === 'confirmed').map((p) => daysBetween(p.date, today));
  let weeks = 0;
  for (let w = 0; w < 4; w++) if (confirmed.some((age) => age >= 7 * w && age < 7 * (w + 1))) weeks++;
  return weeks >= 3 ? 'auto' : 'ask';
}

export function dueItems(f: HabitsFile, today: string): { auto: Habit[]; ask: Habit[] } {
  const due = f.habits.filter((h) => isDue(h, today));
  return { auto: due.filter((h) => h.mode === 'auto'), ask: due.filter((h) => h.mode === 'ask') };
}

export function recordPurchases(f: HabitsFile, items: ItemRef[], date: string, status: PurchaseStatus): void {
  for (const item of items) {
    const { habit } = getOrCreate(f, item, 'ask');
    if (!habit.purchases.some((p) => p.date === date)) habit.purchases.push({ date, status });
    recompute(habit);
  }
}

export function recordAnswer(f: HabitsFile, key: string, answer: 'yes' | 'no', today: string): Habit {
  const h = f.habits.find((x) => x.key === key);
  if (!h) throw new Error(`Unknown habit "${key}"`);
  h.last_asked = today;
  if (answer === 'yes') {
    h.declines_in_row = 0;
    return h;
  }
  h.declines_in_row += 1;
  const eff = effectiveInterval(h);
  if (h.declines_in_row >= WIDEN_AFTER_DECLINES && eff) {
    h.interval_override = Math.round(eff * 1.5);
    h.declines_in_row = 0;
  }
  return h;
}

/** Folds real store orders in: confirms matching pending purchases, drops stale ones, learns external purchases. */
export function reconcile(f: HabitsFile, orders: Order[], today: string): { confirmed: number; dropped: number; added: number } {
  let confirmed = 0;
  let dropped = 0;
  let added = 0;
  for (const order of [...orders].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const item of order.items) {
      const { habit, created } = getOrCreate(f, item, 'track');
      if (created) added++;
      if (habit.purchases.some((p) => p.status === 'confirmed' && p.date === order.date)) continue;
      const pending = habit.purchases.findIndex((p) => {
        const age = daysBetween(p.date, order.date);
        return p.status === 'pending' && age >= 0 && age <= PENDING_MATCH_DAYS;
      });
      if (pending >= 0) {
        habit.purchases.splice(pending, 1);
        confirmed++;
      }
      habit.purchases.push({ date: order.date, status: 'confirmed' });
    }
  }
  for (const h of f.habits) {
    const before = h.purchases.length;
    h.purchases = h.purchases.filter((p) => p.status === 'confirmed' || daysBetween(p.date, today) <= PENDING_TTL_DAYS);
    dropped += before - h.purchases.length;
    recompute(h);
  }
  return { confirmed, dropped, added };
}

export function proposals(f: HabitsFile, today: string) {
  return f.habits
    .filter((h) => effectiveInterval(h) !== undefined)
    .map((h) => ({ key: h.key, name: h.name, interval_days: effectiveInterval(h), mode: h.mode, proposed_mode: proposeMode(h, today) }))
    .sort((a, b) => (a.interval_days ?? 0) - (b.interval_days ?? 0));
}
