#!/usr/bin/env node
/**
 * Prints the long QA description used as a mock server's `--description`.
 *
 * The Claude Code truncation plan adds a second stdio mock whose server
 * description is this text, which pushes the compact catalog past
 * Claude Code's tool-description cap:
 *
 *   pnpm qa:router add stdio-mock-long \
 *     --description "$(pnpm --silent qa:long-description)" \
 *     -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts
 *
 * `--silent` keeps pnpm's own banner out of the captured value; without
 * it the description would start with the script banner lines.
 *
 * The text lives in `mock-long-description.ts`, the single source it
 * shares with the mock MCP servers and the mock LLM expectations.
 */
import { LONG_DESCRIPTION } from './mock-long-description.js';

console.log(LONG_DESCRIPTION);
