#!/usr/bin/env node
/**
 * Standalone mock LLM for the manual QA stack.
 *
 * The mock serves three wire protocols from one scripted conversation
 * store: the OpenAI chat completions API (`GET /v1/models`,
 * `POST /v1/chat/completions`) used by opencode and GitHub Copilot CLI,
 * the Anthropic Messages API (`POST /v1/messages` plus its
 * `count_tokens` probe) used by Claude Code, and the OpenAI Responses
 * API (`POST /v1/responses`) used by Codex CLI. All serve deterministic,
 * scripted conversations from `scripts.ts` and verify every incoming
 * request against the script step's expectations. It is the primary
 * verification point of the manual tests: the log it keeps contains the
 * complete raw request bodies (including the tool list the coding agent
 * advertised), the expectation check results, and the complete response
 * bodies.
 *
 * Admin API used by `pnpm qa:llm` and `pnpm qa:agent`:
 *
 *   GET  /health            liveness plus current script state
 *   GET  /admin/scripts     built-in scripts
 *   GET  /admin/status      current script, step, request count
 *   POST /admin/script      select a script (`{"name": "..."}`) or
 *                           install an inline one (`{"steps": [...]}`)
 *   POST /admin/reset       reset the step and clear the log
 *   GET  /admin/log         every logged request/response pair
 *
 * Every served request is also written to stdout as one JSON line, so
 * `docker compose logs mock-llm` shows the raw traffic as well.
 *
 * Usage:
 *   tsx qa/scripts/mock-llm/server.ts --port 8080 [--script stdio-roundtrip]
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseArgs } from 'node:util';
import { anthropicProtocol } from './anthropic.js';
import { openaiProtocol } from './completions.js';
import { readBody, sendJson } from './http.js';
import { responsesProtocol } from './responses.js';
import {
  handleCountTokens,
  handleInference,
  statusPayload,
  type ServerState,
} from './inference.js';
import { LlmRequestLog } from './log.js';
import {
  getScript,
  listScripts,
  scriptNames,
  type MockLlmScript,
  type ScriptStep,
} from './scripts.js';

/**
 * Resolves an admin payload into a script.
 *
 * @param payload - The parsed `/admin/script` body.
 * @returns The script, or undefined when the payload is not usable.
 */
function resolveScript(payload: {
  name?: string;
  description?: string;
  steps?: ScriptStep[];
}): MockLlmScript | undefined {
  if (Array.isArray(payload.steps)) {
    return {
      name: payload.name ?? 'custom',
      description: payload.description ?? 'Inline script installed by the tester.',
      steps: payload.steps,
    };
  }
  return typeof payload.name === 'string' ? getScript(payload.name) : undefined;
}

/**
 * Handles `/admin/script`: selects a script and resets the run.
 *
 * @param req - The incoming request.
 * @param res - The server response.
 * @param state - The mutable server state.
 */
async function handleSelectScript(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
): Promise<void> {
  let payload: { name?: string; description?: string; steps?: ScriptStep[] };
  try {
    payload = JSON.parse(await readBody(req)) as typeof payload;
  } catch {
    sendJson(res, 400, { error: { message: 'invalid JSON body' } });
    return;
  }
  const script = resolveScript(payload);
  if (script === undefined) {
    sendJson(res, 404, {
      error: { message: `unknown script "${payload.name ?? ''}"` },
      scripts: scriptNames(),
    });
    return;
  }
  state.script = script;
  state.stepIndex = 0;
  state.log.clear();
  console.log(`[mock-llm] script selected: ${script.name} (${script.steps.length} steps)`);
  sendJson(res, 200, {
    script: { name: script.name, description: script.description, steps: script.steps.length },
  });
}

/**
 * Routes the inference endpoints of both wire protocols.
 *
 * @param req - The incoming request.
 * @param res - The server response.
 * @param state - The mutable server state.
 * @param pathname - The request path.
 * @param method - The HTTP method.
 * @returns True when the request was handled.
 */
async function routeInference(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (method === 'POST' && pathname === '/v1/chat/completions') {
    await handleInference(req, res, state, openaiProtocol);
    return true;
  }
  if (method === 'POST' && pathname === '/v1/messages') {
    await handleInference(req, res, state, anthropicProtocol);
    return true;
  }
  if (method === 'POST' && pathname === '/v1/responses') {
    await handleInference(req, res, state, responsesProtocol);
    return true;
  }
  if (method === 'POST' && pathname === '/v1/messages/count_tokens') {
    await handleCountTokens(req, res);
    return true;
  }
  if ((method === 'GET' || method === 'HEAD') && pathname === '/api/hello') {
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

/**
 * Routes one incoming request.
 *
 * @param req - The incoming request.
 * @param res - The server response.
 * @param state - The mutable server state.
 */
async function route(req: IncomingMessage, res: ServerResponse, state: ServerState): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';
  if (await routeInference(req, res, state, url.pathname, method)) {
    return;
  }
  if (method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, statusPayload(state));
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/models') {
    sendJson(res, 200, { object: 'list', data: [{ id: 'qa-mock', object: 'model' }] });
    return;
  }
  if (method === 'GET' && url.pathname === '/admin/scripts') {
    sendJson(res, 200, { scripts: listScripts() });
    return;
  }
  if (method === 'GET' && url.pathname === '/admin/status') {
    sendJson(res, 200, statusPayload(state));
    return;
  }
  if (method === 'GET' && url.pathname === '/admin/log') {
    sendJson(res, 200, { ...statusPayload(state), requests: state.log.list() });
    return;
  }
  if (method === 'POST' && url.pathname === '/admin/script') {
    await handleSelectScript(req, res, state);
    return;
  }
  if (method === 'POST' && url.pathname === '/admin/reset') {
    state.stepIndex = 0;
    state.log.clear();
    console.log('[mock-llm] reset');
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 404, { error: { message: 'not found' } });
}

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    script: { type: 'string' },
  },
});

/**
 * Parses and validates the listen port.
 *
 * @param raw - The raw port value.
 * @returns The port number.
 */
function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 8080;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return port;
}

/**
 * Starts the mock LLM and prints the listening line.
 */
async function main(): Promise<void> {
  const state: ServerState = { script: null, stepIndex: 0, log: new LlmRequestLog() };
  if (values.script !== undefined) {
    const script = getScript(values.script);
    if (script === undefined) {
      throw new Error(
        `unknown --script "${values.script}"; known scripts: ${scriptNames().join(', ')}`,
      );
    }
    state.script = script;
  }
  const port = parsePort(values.port ?? process.env.QA_LLM_PORT);
  const host = values.host ?? process.env.QA_LLM_HOST ?? '0.0.0.0';
  const server = createServer((req, res) => {
    route(req, res, state).catch((err: unknown) => {
      console.error(`[mock-llm] request failed: ${String(err)}`);
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, 500, { error: { message: 'internal error' } });
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolvePromise);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  console.log(
    JSON.stringify({
      event: 'listening',
      host,
      port: actualPort,
      script: state.script?.name ?? null,
    }),
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
