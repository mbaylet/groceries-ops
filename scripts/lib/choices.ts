import { parseIngredientLine } from './ingredient-line.ts';
import { tokens } from './normalize.ts';
import { paths } from './paths.ts';
import { readYaml, writeYaml } from './yaml-io.ts';

export interface Choice { ean: string; label: string; updated: string }
export interface ChoicesFile { choices: Record<string, Choice> }

export const loadChoices = (): ChoicesFile => readYaml<ChoicesFile>(paths.choices(), { choices: {} });
export const saveChoices = (f: ChoicesFile): void => writeYaml(paths.choices(), f);

/** "20 cl de crème fraîche" and "Crème fraîche" share the key "creme fraiche". */
export function choiceKey(ingredient: string): string {
  const name = parseIngredientLine(ingredient).name || ingredient;
  return tokens(name).join(' ');
}

export function getChoice(f: ChoicesFile, ingredient: string): Choice | undefined {
  return f.choices[choiceKey(ingredient)];
}

export function setChoice(f: ChoicesFile, ingredient: string, ean: string, label: string, today: string): Choice {
  const key = choiceKey(ingredient);
  if (!key) throw new Error('empty ingredient');
  const choice = { ean, label, updated: today };
  f.choices[key] = choice;
  return choice;
}

export function removeChoice(f: ChoicesFile, ingredient: string): boolean {
  const key = choiceKey(ingredient);
  if (!(key in f.choices)) return false;
  delete f.choices[key];
  return true;
}
