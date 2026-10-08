import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** User-layer root: $GROCERIES_ROOT if set, else the repo root. */
export function dataRoot(): string {
  const env = process.env.GROCERIES_ROOT;
  return env ? resolve(REPO_ROOT, env) : REPO_ROOT;
}

export const paths = {
  profile: () => join(dataRoot(), 'profile.yml'),
  data: () => join(dataRoot(), 'data'),
  recipes: () => join(dataRoot(), 'data', 'recipes'),
  habits: () => join(dataRoot(), 'data', 'habits.yml'),
  choices: () => join(dataRoot(), 'data', 'product-choices.yml'),
  runs: () => join(dataRoot(), 'data', 'runs'),
  pending: () => join(dataRoot(), 'data', 'pending.yml'),
  productBrief: () => join(dataRoot(), 'data', 'product-brief.md'),
  profileTemplate: () => join(REPO_ROOT, 'config', 'profile.template.yml'),
  briefTemplate: () => join(REPO_ROOT, 'config', 'product-brief.template.md'),
  staples: () => join(REPO_ROOT, 'config', 'staples.default.yml'),
  providersDir: () => join(REPO_ROOT, 'providers'),
  provider: (id: string) => join(REPO_ROOT, 'providers', `${id}.yml`),
  settings: () => join(REPO_ROOT, '.claude', 'settings.json'),
  fixtures: (sourceId: string) => join(REPO_ROOT, 'tests', 'fixtures', sourceId),
};
