#!/usr/bin/env node
/**
 * Emulates a wrapped stdio downstream MCP server, like `npx <pkg>`: this
 * process spawns the real server as a child and proxies the router's
 * stdin/stdout to it. It records both pids as JSON in the file named by
 * MCP_TEST_TREE_PID_FILE so tests can verify that the router terminates
 * the whole process tree, not just the wrapper it spawned directly.
 *
 * Usage: node fixture-wrapper-server.mjs <command> [args...]
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

if (process.env.MCP_TEST_TREE_PID_FILE !== undefined) {
  fs.writeFileSync(
    process.env.MCP_TEST_TREE_PID_FILE,
    JSON.stringify({ wrapper: process.pid, server: child.pid }),
  );
}

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 0 : 1));
});
