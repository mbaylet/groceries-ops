import { execFile } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from './lib/args.ts';
import { isMain, printJson, runMain } from './lib/cli.ts';
import { fetchHtml, type Fetcher } from './lib/http.ts';
import { probeSession, type ProbeResult } from './lib/mcp-probe.ts';
import { paths } from './lib/paths.ts';
import { loadProfile } from './lib/profile.ts';
import { classifySession, listProviderIds, loadProvider, missingDenies, type McpProvider, type Provider } from './lib/provider.ts';
import { getSource, sourceIds } from './recipe-sources/index.ts';

export type Status = 'pass' | 'fail' | 'warn' | 'unknown';
export interface Check { id: string; status: Status; message: string; fix?: string; blocking: boolean }
export interface DoctorReport { onboardingNeeded: boolean; planEnabled: boolean; blocking: boolean; checks: Check[] }
export interface DoctorDeps {
  nodeVersion: string;
  listMcpServers: () => Promise<string>;
  fetcher: Fetcher;
  probe: (p: McpProvider) => Promise<ProbeResult>;
  readSettings: () => unknown;
  readFixture: (sourceId: string) => string | undefined;
}

export function nodeVersionOk(v: string): boolean {
  const [major, minor] = v.replace(/^v/, '').split('.').map(Number);
  if (major > 23) return true;
  if (major === 23) return minor >= 6;
  if (major === 22) return minor >= 18;
  return false;
}

export async function runDoctor(deps: DoctorDeps, opts: { offline: boolean }): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (id: string, status: Status, message: string, blocking: boolean, fix?: string) =>
    checks.push(fix ? { id, status, message, fix, blocking } : { id, status, message, blocking });

  add('node', nodeVersionOk(deps.nodeVersion) ? 'pass' : 'fail', `Node ${deps.nodeVersion}`, true, 'Install Node 22.18+ (or 23.6+)');

  if (!existsSync(paths.profile())) copyFileSync(paths.profileTemplate(), paths.profile());
  const profile = loadProfile({ sources: sourceIds(), providers: listProviderIds() });
  let onboardingNeeded = false;
  if (profile.status === 'ok') add('profile', 'pass', 'profile.yml is valid', false);
  else {
    onboardingNeeded = true;
    if (profile.status === 'invalid') add('profile', 'fail', profile.errors.join('; '), false, 'Fix profile.yml or run /groceries onboarding');
    else add('profile', 'warn', 'profile.yml is still the template', false, 'Run /groceries onboarding');
  }

  try {
    mkdirSync(paths.data(), { recursive: true });
    accessSync(paths.data(), constants.W_OK);
    add('data-dir', 'pass', `${paths.data()} is writable`, true);
  } catch (e) {
    add('data-dir', 'fail', `${paths.data()} is not writable: ${(e as Error).message}`, true);
  }

  const providerId = profile.status === 'ok' ? profile.profile.store.provider : 'carrefour';
  let provider: Provider | undefined;
  try {
    provider = loadProvider(providerId);
    add('provider', 'pass', `${provider.label} (${provider.kind})`, true);
  } catch (e) {
    add('provider', 'fail', (e as Error).message, true);
  }

  if (provider?.kind === 'mcp') {
    const missing = missingDenies(provider, deps.readSettings());
    if (missing.length === 0) add('checkout-deny', 'pass', 'All checkout tools are denied', true);
    else add('checkout-deny', 'fail', `Checkout tools not denied: ${missing.join(', ')}`, true, 'Add them to permissions.deny in .claude/settings.json');

    // Profile comes first: no store checks until onboarding has produced a valid profile.
    if (profile.status !== 'ok') {
      // skipped silently — onboarding runs before anything touches the store
    } else if (opts.offline) add('mcp-registered', 'unknown', 'skipped (--offline)', false);
    else {
      try {
        const out = await deps.listMcpServers();
        if (out.includes(`${provider.mcp_server}:`)) add('mcp-registered', 'pass', `MCP server "${provider.mcp_server}" is configured`, true);
        else add('mcp-registered', 'fail', `MCP server "${provider.mcp_server}" is not configured`, true, provider.install);
      } catch (e) {
        add('mcp-registered', 'unknown', `could not run \`claude mcp list\`: ${(e as Error).message}`, false);
      }
    }
  }

  const sourceList = profile.status === 'ok' ? profile.profile.recipes.sources : sourceIds();
  let planEnabled = false;
  for (const id of sourceList) {
    const s = getSource(id);
    const problems: string[] = [];
    const fixture = deps.readFixture(id);
    if (fixture === undefined) problems.push('no fixture');
    else {
      try {
        s.parse(fixture, s.healthUrl);
      } catch (e) {
        problems.push(`fixture: ${(e as Error).message}`);
      }
    }
    if (!opts.offline) {
      try {
        s.parse(await deps.fetcher(s.healthUrl), s.healthUrl);
      } catch (e) {
        problems.push(`live: ${(e as Error).message}`);
      }
    }
    if (problems.length === 0) {
      planEnabled = true;
      add(`recipe-source:${id}`, 'pass', `${s.label} recipes parse${opts.offline ? ' (fixture only)' : ''}`, false);
    } else add(`recipe-source:${id}`, 'warn', `${s.label}: ${problems.join('; ')}`, false);
  }
  if (!planEnabled) add('plan-mode', 'fail', 'All recipe sources failing — plan mode disabled (add mode still works)', false);

  if (profile.status === 'ok' && provider?.kind === 'mcp' && !opts.offline) {
    try {
      const state = classifySession(await deps.probe(provider), provider.capabilities.session_check);
      if (state === 'ok') add('login', 'pass', `Logged in to ${provider.label}`, true);
      else if (state === 'expired')
        add('login', 'fail', `Not logged in to ${provider.label}`, true, `Ask Claude to log you in (runs ${provider.capabilities.login})`);
      else add('login', 'unknown', 'Session state could not be confirmed', false, 'Run /groceries setup');
    } catch (e) {
      add('login', 'unknown', `server busy or unreachable: ${(e as Error).message}`, false, 'Run /groceries setup');
    }
  }

  const blocking = checks.some((c) => c.blocking && c.status === 'fail');
  return { onboardingNeeded, planEnabled, blocking, checks };
}

const run = promisify(execFile);
const realDeps: DoctorDeps = {
  nodeVersion: process.version,
  listMcpServers: async () => (await run('claude', ['mcp', 'list'], { timeout: 60_000 })).stdout,
  fetcher: fetchHtml,
  probe: (p) => probeSession(p),
  readSettings: () => (existsSync(paths.settings()) ? JSON.parse(readFileSync(paths.settings(), 'utf8')) : {}),
  readFixture: (id) => {
    const dir = paths.fixtures(id);
    if (!existsSync(dir)) return undefined;
    const f = readdirSync(dir).find((n) => n.startsWith('recipe-'));
    return f ? readFileSync(join(dir, f), 'utf8') : undefined;
  },
};

const ICON: Record<Status, string> = { pass: '✅', fail: '❌', warn: '⚠️ ', unknown: '❔' };

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2), ['json', 'offline']);
  const report = await runDoctor(realDeps, { offline: Boolean(flags['offline']) });
  if (flags['json']) printJson(report);
  else {
    for (const c of report.checks) {
      console.log(`${ICON[c.status]} ${c.id} — ${c.message}`);
      if (c.fix && c.status !== 'pass') console.log(`   fix: ${c.fix}`);
    }
    console.log(report.blocking ? '\nBlocked: fix the ❌ items above.' : report.onboardingNeeded ? '\nRun /groceries onboarding.' : '\nReady.');
  }
  if (report.blocking) process.exitCode = 1;
}

if (isMain(import.meta.url)) runMain(main);
