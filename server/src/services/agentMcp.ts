import { join } from 'path';
import { DATA_DIR } from './dataDir.js';
import { writeJsonAtomic } from './atomicJson.js';
import { getMcpConfig } from './mcpConfig.js';
import { listClients } from './mcpAuth.js';

/**
 * How a Claude session that JabutiStudio starts reaches the Knowledge tools. The session gets the same MCP server
 * (`shipyard`) the dashboard serves, through `--mcp-config`, so nothing is written into the game's folder. The file
 * names the endpoint only: the OAuth token is obtained by Claude itself, from the consent page the user approves, and
 * never appears on a command line.
 */

export const MCP_SERVER_NAME = 'shipyard';
const AGENT_MCP_FILE = join(DATA_DIR, 'agent-mcp.json');

/** disabled: the MCP server is off · needs-authorization: on, but no client has been approved yet · ready */
export type KnowledgeState = 'disabled' | 'needs-authorization' | 'ready';

/** The endpoint of the server that is running (dev 5420, Electron 5430 via SHIPYARD_PORT). Loopback only. */
export function mcpEndpoint(): string {
  const port = process.env.SHIPYARD_PORT || '5420';
  return `http://127.0.0.1:${port}/mcp`;
}

export function knowledgeState(): KnowledgeState {
  const cfg = getMcpConfig();
  if (!cfg.enabled) return 'disabled';
  if (cfg.requireAuth && listClients().length === 0) return 'needs-authorization';
  return 'ready';
}

/**
 * The `--mcp-config` file a Claude session is started with, or null while the MCP server is off (then the session
 * simply has no Knowledge tools, and the dialog has already told the user why).
 */
export async function agentMcpConfigFile(): Promise<string | null> {
  if (knowledgeState() === 'disabled') return null;
  await writeJsonAtomic(AGENT_MCP_FILE, {
    mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: mcpEndpoint() } },
  });
  return AGENT_MCP_FILE;
}
