import { choiceKey } from './choices.ts';
import { paths } from './paths.ts';
import { readYaml, writeYaml } from './yaml-io.ts';

/** Something the user parked for the next cart; the product is chosen later, at cart time. */
export interface PendingItem { key: string; item: string; qty?: string; added: string }
export interface PendingFile { items: PendingItem[] }

export const loadPending = (): PendingFile => readYaml<PendingFile>(paths.pending(), { items: [] });
export const savePending = (f: PendingFile): void => writeYaml(paths.pending(), f);

/** Parks an item. Parking the same thing twice keeps one entry (the latest quantity wins). */
export function addPending(f: PendingFile, item: string, today: string, qty?: string): { entry: PendingItem; duplicate: boolean } {
  const key = choiceKey(item);
  if (!key) throw new Error('empty item');
  const existing = f.items.find((i) => i.key === key);
  if (existing) {
    if (qty) existing.qty = qty;
    return { entry: existing, duplicate: true };
  }
  const entry: PendingItem = { key, item: item.trim(), ...(qty ? { qty } : {}), added: today };
  f.items.push(entry);
  return { entry, duplicate: false };
}

/** Removes the entries matching these names (same matching as `addPending`); returns what was removed. */
export function removePending(f: PendingFile, items: string[]): PendingItem[] {
  const keys = new Set(items.map(choiceKey));
  const removed = f.items.filter((i) => keys.has(i.key));
  f.items = f.items.filter((i) => !keys.has(i.key));
  return removed;
}
