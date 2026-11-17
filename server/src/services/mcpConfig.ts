import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { DATA_DIR } from './dataDir.js';

/**
 * Whether the JabutiStudio MCP server is switched on, and whether it asks clients to authorize. Off by default: the
 * server answers nothing until the user turns it on in Settings.
 */
export interface McpConfig {
  enabled: boolean;
  requireAuth: boolean;
}

const MCP_CONFIG_FILE = join(DATA_DIR, 'mcp-config.json');

let current: McpConfig = { enabled: false, requireAuth: true };

export function getMcpConfig(): McpConfig {
  return current;
}

export async function loadMcpConfig(): Promise<McpConfig> {
  try {
    const raw = await readFile(MCP_CONFIG_FILE, 'utf-8');
    current = { enabled: false, requireAuth: true, ...JSON.parse(raw) };
  } catch {
    current = { enabled: false, requireAuth: true };
  }
  return current;
}

export async function saveMcpConfig(config: McpConfig): Promise<void> {
  current = config;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(MCP_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}
