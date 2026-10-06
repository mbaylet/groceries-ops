import { existsSync, readFileSync, readdirSync } from 'node:fs';
import YAML from 'yaml';
import { paths } from './paths.ts';

export const CAPABILITY_NAMES = [
  'session_check', 'login', 'search', 'add_to_cart', 'set_quantity', 'read_cart', 'order_history', 'frequent',
] as const;

export interface SessionCheck { tool: string; args: Record<string, unknown>; ok_pattern: string; expired_pattern: string }
export interface McpProvider {
  id: string;
  label: string;
  kind: 'mcp';
  mcp_server: string;
  install: string;
  spawn: { command: string; args: string[] };
  notes?: string;
  capabilities: {
    session_check: SessionCheck;
    login: string;
    search: string;
    add_to_cart: string;
    set_quantity: string;
    read_cart: string;
    order_history: string[];
    frequent?: string;
  };
  forbidden: string[];
}
export interface ListProvider { id: string; label: string; kind: 'list' }
export type Provider = McpProvider | ListProvider;
export type SessionState = 'ok' | 'expired' | 'unknown';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function listProviderIds(): string[] {
  if (!existsSync(paths.providersDir())) return [];
  return readdirSync(paths.providersDir()).filter((f) => f.endsWith('.yml')).map((f) => f.slice(0, -4));
}

export function validateProvider(raw: unknown, id: string): { ok: true; provider: Provider } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`);
  if (!isObj(raw)) return { ok: false, errors: [`${id}: must be a YAML mapping`] };
  if (raw.id !== id) err('id', `must equal the file name "${id}"`);
  if (!isStr(raw.label)) err('label', 'must be a string');
  if (raw.kind === 'list') return errors.length ? { ok: false, errors } : { ok: true, provider: raw as unknown as ListProvider };
  if (raw.kind !== 'mcp') return { ok: false, errors: [...errors, 'kind: must be "mcp" or "list"'] };

  for (const k of ['mcp_server', 'install'] as const) if (!isStr(raw[k])) err(k, 'must be a string');
  const spawn = isObj(raw.spawn) ? raw.spawn : {};
  if (!isStr(spawn.command)) err('spawn.command', 'must be a string');
  if (!Array.isArray(spawn.args) || !spawn.args.every((a) => typeof a === 'string')) err('spawn.args', 'must be a list of strings');
  const forbidden = Array.isArray(raw.forbidden) && raw.forbidden.every(isStr) ? (raw.forbidden as string[]) : [];
  if (!Array.isArray(raw.forbidden)) err('forbidden', 'must be a list of tool names');

  const caps = isObj(raw.capabilities) ? raw.capabilities : {};
  const tool = (path: string, v: unknown, optional = false) => {
    if (v === undefined && optional) return;
    if (!isStr(v)) err(path, 'must be a tool name');
    else if (forbidden.includes(v)) err(path, `"${v}" is forbidden`);
  };
  for (const k of ['login', 'search', 'add_to_cart', 'set_quantity', 'read_cart'] as const) tool(`capabilities.${k}`, caps[k]);
  tool('capabilities.frequent', caps.frequent, true);
  if (!Array.isArray(caps.order_history) || caps.order_history.length === 0) err('capabilities.order_history', 'must be a non-empty list');
  else caps.order_history.forEach((t, i) => tool(`capabilities.order_history[${i}]`, t));

  const sc = isObj(caps.session_check) ? caps.session_check : {};
  tool('capabilities.session_check.tool', sc.tool);
  if (sc.args !== undefined && !isObj(sc.args)) err('capabilities.session_check.args', 'must be a mapping');
  for (const k of ['ok_pattern', 'expired_pattern'] as const) {
    const p = sc[k];
    if (!isStr(p)) err(`capabilities.session_check.${k}`, 'must be a regex string');
    else {
      try {
        new RegExp(p);
      } catch {
        err(`capabilities.session_check.${k}`, 'invalid regex');
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  const provider = raw as unknown as McpProvider;
  provider.capabilities.session_check.args ??= {};
  return { ok: true, provider };
}

export function loadProvider(id: string): Provider {
  const file = paths.provider(id);
  if (!existsSync(file)) throw new Error(`Unknown provider "${id}" (known: ${listProviderIds().join(', ')})`);
  const v = validateProvider(YAML.parse(readFileSync(file, 'utf8')), id);
  if (!v.ok) throw new Error(`providers/${id}.yml is invalid: ${v.errors.join('; ')}`);
  return v.provider;
}

export function mcpToolName(p: McpProvider, tool: string): string {
  return `mcp__${p.mcp_server}__${tool}`;
}

export function missingDenies(p: McpProvider, settings: unknown): string[] {
  const perms = isObj(settings) && isObj(settings.permissions) ? settings.permissions : {};
  const deny = Array.isArray(perms.deny) ? perms.deny : [];
  return p.forbidden.map((t) => mcpToolName(p, t)).filter((name) => !deny.includes(name));
}

export function classifySession(result: { isError?: boolean; text: string }, check: SessionCheck): SessionState {
  if (result.isError) return 'expired';
  if (new RegExp(check.expired_pattern).test(result.text)) return 'expired';
  if (new RegExp(check.ok_pattern).test(result.text)) return 'ok';
  return 'unknown';
}
