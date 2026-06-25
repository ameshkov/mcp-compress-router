#!/usr/bin/env node
/// <reference types="node" />

import * as path from 'node:path';
import dotenv from 'dotenv';
import { Command } from 'commander';
import { resolveConfigDir } from './services/index.js';
import { Logger } from './utils/index.js';
import { registerAllCommands } from './cli/register-commands.js';

async function main() {
  // Load .env from the config directory before any config resolution
  // or env var expansion. `quiet` suppresses dotenv's startup log line.
  dotenv.config({
    path: path.join(resolveConfigDir(), '.env'),
    quiet: true,
  });

  const program = new Command();

  program
    .name('mcp-compress-router')
    .description('Compress all connected MCP servers into a single router MCP');

  registerAllCommands(program);

  await program.parseAsync();
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);

  // Use a fresh error-level logger for fatal startup errors.
  const fatalLogger = new Logger('debug');

  if (message.includes('Failed to connect to server')) {
    fatalLogger.error('Cannot build complete tool catalog — downstream connection failed', {
      error: message,
    });
  } else {
    fatalLogger.error('Fatal startup error', { error: message });
  }

  process.exitCode = 1;
  process.exit(1);
});
