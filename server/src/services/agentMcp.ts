import { join } from 'path';
import { DATA_DIR } from './dataDir.js';
import { writeJsonAtomic } from './atomicJson.js';
import { getMcpConfig } from './mcpConfig.js';
import { listAuthorizedClients, latestUse } from './mcpAuth.js';

/**
 * How a Claude or Codex session that JabutiStudio starts reaches the Knowledge tools. The session gets the same MCP
 * server (`shipyard`) the dashboard serves: Claude through `--mcp-config`, Codex through a `-c` override, so nothing is
 * written into the game's folder or the CLI's global config. The endpoint is named, never a token: the OAuth token is
 * obtained by the CLI itself, from the consent page the user approves.
 */

export const MCP_SERVER_NAME = 'shipyard';
const AGENT_MCP_FILE = join(DATA_DIR, 'agent-mcp.json');

/**
 * disabled: the MCP server is off · needs-authorization: on, but this agent has no approved (completed-login) client ·
 * ready: on, and either auth is off or this agent's client completed login. `ready` says nothing about the agent's
 * process having discovered the tools: only a session that calls them proves that.
 */
export type KnowledgeState = 'disabled' | 'needs-authorization' | 'ready';
export type KnowledgeAgent = 'claude' | 'codex';

/** Tool names an agent can call for Knowledge. Kept in step with mcpServer.ts MCP_TOOLS. */
export const KNOWLEDGE_TOOLS = ['list_systems', 'get_system', 'get_design_context', 'propose_system', 'propose_design_decision'] as const;

/** Client names the CLIs register under (Codex: "Codex"; Claude Code: "Claude Code"). */
const AGENT_CLIENT_NAME: Record<KnowledgeAgent, RegExp> = { claude: /claude/i, codex: /codex/i };

/** The endpoint of the server that is running (dev 5420, Electron 5430 via SHIPYARD_PORT). Loopback only. */
export function mcpEndpoint(): string {
  const port = process.env.SHIPYARD_PORT || '5420';
  return `http://127.0.0.1:${port}/mcp`;
}

/**
 * What the user runs to approve Codex. The server exists only as the launch-time `-c`, so a bare
 * `codex mcp login shipyard` fails with "No MCP server named 'shipyard'": the login needs the same override.
 */
export function codexLoginCommand(): string {
  return `codex -c mcp_servers.${MCP_SERVER_NAME}.url=${mcpEndpoint()} mcp login ${MCP_SERVER_NAME}`;
}

export interface KnowledgeDiagnosis {
  state: KnowledgeState;
  /** What is blocking, in a sentence. */
  reason: string;
  /** How to resolve it; empty when nothing is needed. */
  fix: string;
}

/** Diagnosis from configuration and approvals. Does not touch the network (see probeKnowledgeEndpoint). */
export function knowledgeDiagnosis(agent?: KnowledgeAgent): KnowledgeDiagnosis {
  const cfg = getMcpConfig();
  if (!cfg.enabled) {
    return { state: 'disabled', reason: 'The MCP server is off in JabutiStudio Settings.', fix: 'Turn the MCP server on in Settings.' };
  }
  if (!cfg.requireAuth) return { state: 'ready', reason: 'Authentication is off; the endpoint is open on loopback.', fix: '' };
  const authorized = listAuthorizedClients();
  const mine = agent ? authorized.filter(c => AGENT_CLIENT_NAME[agent].test(c.clientName)) : authorized;
  if (mine.length > 0) {
    const use = latestUse(mine.map(c => c.clientId));
    // Last use by the client since the server started: evidence about the client, never proof about a session starting now.
    const seen = use?.toolsListedAt ? ` Last recorded use by this client (not proof for a new session): tools listed at ${use.toolsListedAt}${use.toolCalls ? `, ${use.toolCalls} tool call(s), last ${use.tool}` : ''}.` : ' No use by this client has been recorded since the server started.';
    return { state: 'ready', reason: `Approved client: ${mine.map(c => c.clientName).join(', ')}.${seen}`, fix: '' };
  }
  const label = agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : 'agent';
  const others = authorized.length > 0 && agent
    ? ` Other clients are approved (${authorized.map(c => c.clientName).join(', ')}), which does not authorize ${label}.`
    : '';
  const fix = agent === 'codex'
    ? `In a terminal run \`${codexLoginCommand()}\` and approve the page that opens.`
    : agent === 'claude'
      ? 'In the Claude session run /mcp, choose shipyard, and approve the page that opens.'
      : 'Approve the agent from its own login (Claude: /mcp; Codex: codex login with the shipyard override).';
  return { state: 'needs-authorization', reason: `No approved ${label} client has completed authorization yet.${others}`, fix };
}

export function knowledgeState(agent?: KnowledgeAgent): KnowledgeState {
  return knowledgeDiagnosis(agent).state;
}

export interface EndpointProbe { ok: boolean; detail: string; tools?: string[] }

/**
 * Asks the endpoint this instance advertises whether it answers as an MCP server. With auth required the call without a
 * token must be refused with 401 (up and guarding); with auth off it lists the tools and every Knowledge tool must be
 * there. A refused connection, a 404 or a missing tool is reported, never hidden.
 */
export async function probeKnowledgeEndpoint(timeoutMs = 2000): Promise<EndpointProbe> {
  const cfg = getMcpConfig();
  if (!cfg.enabled) return { ok: false, detail: 'MCP server is disabled' };
  const url = mcpEndpoint();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (cfg.requireAuth) {
      return res.status === 401
        ? { ok: true, detail: `${url} answered 401 as expected (auth required)` }
        : { ok: false, detail: `${url} answered ${res.status}, expected 401 with auth required` };
    }
    if (!res.ok) return { ok: false, detail: `${url} answered ${res.status}` };
    const body = await res.json() as { result?: { tools?: { name: string }[] } };
    const tools = (body.result?.tools ?? []).map(t => t.name);
    const missing = KNOWLEDGE_TOOLS.filter(t => !tools.includes(t));
    return missing.length
      ? { ok: false, detail: `${url} lists no ${missing.join(', ')}`, tools }
      : { ok: true, detail: `${url} lists all Knowledge tools`, tools };
  } catch (err) {
    return { ok: false, detail: `${url} is not reachable (${(err as Error).message})` };
  }
}

/**
 * A short block put at the top of every agent prompt, saying what state the Knowledge tools are in. An agent that
 * finds no tool, or a tool that refuses, must be able to tell the reviewer why, and must not reconcile systems from memory.
 */
export function knowledgePreamble(agent?: KnowledgeAgent, endpoint?: EndpointProbe): string {
  const head = '## Knowledge (JabutiStudio MCP)';
  const tools = KNOWLEDGE_TOOLS.join(', ');
  // Screen control of the JabutiStudio window is never the way to read its data: the MCP tools are.
  const footer = 'Read JabutiStudio data through these MCP tools, never by controlling the app window.\n\n';
  const d = knowledgeDiagnosis(agent);
  const probeNote = endpoint && !endpoint.ok ? `\nEndpoint check failed: ${endpoint.detail}. Say so in your completion note.` : '';
  switch (d.state) {
    case 'ready':
      return `${head}\nState: ready (approved and configured; tool discovery is proven only by calling a tool). Tools: ${tools}. Read a system (get_system) before changing it. New findings are proposals only: a person approves them. If a tool is missing or refuses, report that instead of reconciling from memory.${probeNote}\n${footer}`;
    case 'needs-authorization':
      return `${head}\nState: needs authorization. ${d.reason} ${d.fix} Until then the tools will not be available: say so in your completion note and do not reconcile systems from memory.${probeNote}\n${footer}`;
    default:
      return `${head}\nState: disabled. ${d.reason} No Knowledge tools exist in this session. Do not reconcile systems from memory; say so in your completion note.\n${footer}`;
  }
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
