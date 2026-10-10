import { ensureConfigDir, readConfigFile, type RawServerEntry } from './config-io.js';

/**
 * Renders the `Timeout:` block for the `get` output. Only the keys
 * present in the raw entry are shown; an absent or empty block renders
 * nothing.
 *
 * @param entry - Raw server entry from mcp.json.
 * @returns The block lines, or an empty array when nothing is configured.
 */
function formatTimeoutBlock(entry: RawServerEntry): string[] {
  const { startup, execution } = entry.timeout ?? {};
  const keys: Array<[string, number]> = [];
  if (startup !== undefined) {
    keys.push(['startup', startup]);
  }
  if (execution !== undefined) {
    keys.push(['execution', execution]);
  }
  if (keys.length === 0) {
    return [];
  }
  return ['Timeout:', ...keys.map(([key, value]) => `  ${key}: ${value}`)];
}

/**
 * Handles the `get <name>` subcommand: prints details for one server.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name to look up.
 * @returns Human-readable output to print to stdout.
 * @throws If the server name is not found.
 */
export async function handleGet(configPath: string, name: string): Promise<string> {
  await ensureConfigDir(configPath);
  const servers = await readConfigFile(configPath);

  const entry = servers[name];
  if (!entry) {
    const available = Object.keys(servers);
    const hint =
      available.length > 0
        ? ` Available servers: ${available.join(', ')}`
        : ' No servers configured.';
    throw new Error(`Server "${name}" not found.${hint}`);
  }

  const lines: string[] = [];
  lines.push(`Name: ${name}`);
  lines.push(`Type: ${entry.type}`);

  if (entry.description) {
    lines.push(`Description: ${entry.description}`);
  }
  if (entry.command) {
    lines.push(`Command: ${entry.command}`);
  }
  if (entry.args && entry.args.length > 0) {
    lines.push(`Args: ${entry.args.join(' ')}`);
  }
  if (entry.env && Object.keys(entry.env).length > 0) {
    lines.push('Environment:');
    for (const [k, v] of Object.entries(entry.env)) {
      lines.push(`  ${k}=${v}`);
    }
  }
  if (entry.url) {
    lines.push(`URL: ${entry.url}`);
  }
  if (entry.headers && Object.keys(entry.headers).length > 0) {
    lines.push('Headers:');
    for (const [k, v] of Object.entries(entry.headers)) {
      lines.push(`  ${k}: ${v}`);
    }
  }
  lines.push(...formatTimeoutBlock(entry));

  return lines.join('\n');
}
