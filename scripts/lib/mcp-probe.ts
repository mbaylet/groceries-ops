import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpProvider } from './provider.ts';

export interface ProbeResult { isError: boolean; text: string }

/** Starts the provider's MCP server on stdio and calls its session-check tool. */
export async function probeSession(p: McpProvider, timeoutMs = 60_000): Promise<ProbeResult> {
  const check = p.capabilities.session_check;
  const transport = new StdioClientTransport({ command: p.spawn.command, args: p.spawn.args, stderr: 'ignore' });
  const client = new Client({ name: 'groceries-ops-doctor', version: '0.1.0' });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });
  const call = (async (): Promise<ProbeResult> => {
    await client.connect(transport);
    const res = (await client.callTool({ name: check.tool, arguments: check.args }, undefined, { timeout: timeoutMs })) as {
      content?: unknown;
      isError?: unknown;
    };
    const content = Array.isArray(res.content) ? res.content : [];
    const text = content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('\n');
    return { isError: res.isError === true, text };
  })();
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
