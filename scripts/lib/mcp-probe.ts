import { openSession, type ToolResult } from './mcp-client.ts';
import type { McpProvider } from './provider.ts';

export type ProbeResult = ToolResult;

/** Starts the provider's MCP server on stdio and calls its session-check tool. */
export async function probeSession(p: McpProvider, timeoutMs = 60_000): Promise<ProbeResult> {
  const session = await openSession(p, timeoutMs);
  try {
    const check = p.capabilities.session_check;
    return await session.call(check.tool, check.args);
  } finally {
    await session.close();
  }
}
