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

/** Tool names an agent can call for Knowledge. Kept in step with mcpServer.ts MCP_TOOLS. */
export const KNOWLEDGE_TOOLS = ['list_systems', 'get_system', 'get_design_context', 'propose_system', 'propose_design_decision'] as const;

/**
 * A short block put at the top of every agent prompt, saying what state the Knowledge tools are in. An agent that
 * finds no tool, or a tool that refuses, must be able to tell the reviewer why, and must not reconcile systems from memory.
 */
export function knowledgePreamble(): string {
  const head = '## Knowledge (JabutiStudio MCP)';
  const tools = KNOWLEDGE_TOOLS.join(', ');
  // Screen control of the JabutiStudio window is never the way to read its data: the MCP tools are.
  const footer = 'Read JabutiStudio data through these MCP tools, never by controlling the app window.\n\n';
  switch (knowledgeState()) {
    case 'ready':
      return `${head}\nState: ready. Tools: ${tools}. Read a system (get_system) before changing it. New findings are proposals only: a person approves them.\n${footer}`;
    case 'needs-authorization':
      return `${head}\nState: needs authorization. The shipyard server is on but no client is approved yet. In Claude, the user runs /mcp and approves shipyard; in Codex, the user runs \`codex mcp login shipyard\`. Until then the tools may fail: say so in your completion note and do not reconcile systems from memory.\n${footer}`;
    default:
      return `${head}\nState: disabled. The MCP server is off in JabutiStudio Settings, so no Knowledge tools exist in this session. Do not reconcile systems from memory; say so in your completion note.\n${footer}`;
  }
}

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
