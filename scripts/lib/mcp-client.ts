import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpProvider } from './provider.ts';

export interface ToolResult { isError: boolean; text: string }
export interface McpSession {
  call(tool: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}

export function parseToolJson(r: ToolResult): unknown {
  if (r.isError) throw new Error(`tool error: ${r.text.slice(0, 300)}`);
  try {
    return JSON.parse(r.text);
  } catch {
    throw new Error(`tool output is not JSON: ${r.text.slice(0, 120)}`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** One stdio MCP session to the provider's server, reused for many calls. */
export async function openSession(p: McpProvider, timeoutMs = 60_000): Promise<McpSession> {
  const env = p.spawn.env ? { ...getDefaultEnvironment(), ...p.spawn.env } : undefined;
  const transport = new StdioClientTransport({ command: p.spawn.command, args: p.spawn.args, env, stderr: 'ignore' });
  const client = new Client({ name: 'groceries-ops', version: '0.1.0' });
  try {
    await withTimeout(client.connect(transport), timeoutMs, 'MCP connect');
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  return {
    async call(tool, args) {
      const res = (await withTimeout(client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs }), timeoutMs, tool)) as {
        content?: unknown;
        isError?: unknown;
      };
      return { isError: res.isError === true, text: contentText(res.content) };
    },
    close: () => client.close().catch(() => {}),
  };
}
