#!/usr/bin/env node
/**
 * Emulates a hung stdio downstream MCP server: it spawns, writes its PID
 * to the file named by the MCP_TEST_PID_FILE environment variable (so a
 * test can verify it was killed), then never answers anything while
 * keeping its stdin/stdout pipes open — exactly like an npx-resolving or
 * network-locked downstream that starts but never completes the MCP
 * initialize handshake.
 */
import * as fs from 'node:fs';

process.stdin.resume();

if (process.env.MCP_TEST_PID_FILE !== undefined) {
  fs.writeFileSync(process.env.MCP_TEST_PID_FILE, String(process.pid));
}

// Keep the process alive until it is killed by the router's graduated
// shutdown (stdin end -> SIGTERM -> SIGKILL).
setInterval(() => {}, 60_000);
