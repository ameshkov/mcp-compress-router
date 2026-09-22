# Manual QA testing

This directory contains the manual test stack for MCP Compress Router:
Gherkin plans, the runner that records verdicts, a Docker Compose
environment with the router and a coding agent, and the mock services
the plans drive.

Everything runs in Docker Compose, and no network access, real MCP
servers, model, or credentials are needed. The tester (a human or an
agent) follows a plan step by step, runs the commands the steps quote
inside the QA workspace, and records a verdict with the BDD runner.

The mock LLM is the center of the stack. It answers the coding agents
with scripted tool calls, validates every request the agent sends
before answering, and keeps the complete raw request/response log. Most
plan assertions are checks in that log: the router's two tools, the
compact catalog, the exact tool-call arguments, and the downstream
result coming back. The other channels are the agent transcript and the
container logs of the mock MCP servers.

## How the stack is wired

```text
host
└── docker compose -f qa/docker-compose.yml
    ├── workspace (mcr-qa-workspace)
    │     router build + QA tooling + stdio mock + opencode +
    │     GitHub Copilot CLI + Claude Code + Codex CLI
    │     ├── mock-llm:8080            scripted LLM (OpenAI chat and
    │     │                            Responses + Anthropic APIs);
    │     │                            raw request log
    │     ├── mock-mcp-http:3100       streamable-http mock MCP
    │     └── mock-mcp-http-oauth:3101 streamable-http mock + mock OAuth
    ├── mock-llm (mcr-qa-mock-llm)
    ├── mock-mcp-http (mcr-qa-mock-mcp-http)
    └── mock-mcp-http-oauth (mcr-qa-mock-mcp-http-oauth)
```

| Service | Purpose |
| --- | --- |
| `workspace` | Long-lived container the tester works in: compiled router, QA scripts, stdio mock MCP server, opencode, GitHub Copilot CLI, Claude Code, Codex CLI, and the headless `qa-browser` OAuth helper |
| `mock-llm` | Mock LLM with scripted conversations, request validation, and the raw request/response log; serves the OpenAI chat completions API, the OpenAI Responses API, and the Anthropic Messages API |
| `mock-mcp-http` | Mock MCP server over streamable-http (no auth) |
| `mock-mcp-http-oauth` | Mock MCP server over streamable-http plus a mock OAuth 2.1 authorization server |

The workspace talks to the mocks over the compose network
(`QA_LLM_URL=http://mock-llm:8080`). No service publishes a host port,
so the stack can never conflict with services already running on the
host. To inspect the mocks from the host, run the commands in the
workspace (`docker compose -f qa/docker-compose.yml exec workspace
curl ...`) or read the container logs
(`docker compose -f qa/docker-compose.yml logs mock-llm`).

## Prepare the environment

Build the images and start the stack from the repository root:

```bash
docker compose -f qa/docker-compose.yml up -d --build
docker compose -f qa/docker-compose.yml exec workspace bash
```

The workspace bakes the repository (router build, QA scripts, plans,
and the coding agents), so rebuild it after any source or QA change:

```bash
docker compose -f qa/docker-compose.yml up -d --build
```

Every command below runs inside the workspace shell unless a step says
"on the host". The repository is at `/app`, so paths relative to the
repository root keep working.

Never run the `pnpm qa:*` commands from a host checkout: the agent
runners resolve `opencode`/`copilot`/`claude`/`codex` from `PATH` and the
router from the checkout's `build/`, so a host run silently tests host
artifacts instead of the workspace image. The commands that talk to the
mock LLM (`pnpm qa:agent`, `pnpm qa:llm`) fail fast when `QA_LLM_URL` is
not set, which is the signal that the shell is outside the workspace.

### Host access to the mocks (optional)

If you explicitly need host access to the mocks (for example to `curl`
the mock LLM admin API), start the stack with the opt-in override:

```bash
docker compose -f qa/docker-compose.yml \
  -f qa/docker-compose.host-ports.yml up -d --build
```

The mocks are then on `127.0.0.1:8080`, `127.0.0.1:3100`, and
`127.0.0.1:3101`. Host-side QA commands additionally need
`QA_LLM_URL=http://127.0.0.1:8080`. The plans never need the override,
and using it re-introduces the port-conflict risk by choice.

## Tools provided in the workspace

| Command | Purpose |
| --- | --- |
| `pnpm qa:setup` | Reset the QA router home (`qa/home`): empty baseline config, no tool cache, no credentials. Run it at the start of every scenario. |
| `pnpm qa:long-description` | Print the long mock description used as a server's `--description` in the Claude Code truncation plan. Capture it as `$(pnpm --silent qa:long-description)` so pnpm's banner stays out of the value. |
| `pnpm qa:router <args>` | Run the management CLI (`add`, `remove`, `list`, `tools`, `enable`, `disable`, `login`, `logout`) against the QA home. |
| `pnpm qa:probe ...` | Spawn the compiled router over stdio, do the MCP handshake, and run one request (`--list`, `--tool <name> --args '<json>'`). Omit `tools` in the args to list a server's tools and their arguments. |
| `pnpm qa:llm ...` | Control and inspect the mock LLM (`list`, `script`, `custom`, `status`, `log`, `reset`). |
| `pnpm qa:agent ...` | Run a coding agent session (`--prompt '<text>'`, `--agent opencode\|copilot\|claude\|codex`) or `--mcp-list`, then report the mock LLM validation result. |
| `pnpm qa:run ...` | The BDD runner that walks the plans and records verdicts. |

The image also installs `qa-browser`, a curl-based "browser" the router
uses for OAuth (`MCP_COMPRESS_ROUTER_BROWSER=qa-browser`). It fetches
the authorization URL and follows the redirect to the router's loopback
callback, so `add` and `login` complete headlessly.

## Preparing the QA home

`pnpm qa:setup` copies the committed baseline
(`qa/fixtures/mcp.jsonc`) to `qa/home/mcp.jsonc` and removes
`tools-cache.json` and `credentials.json`. The baseline has no servers
on purpose: every plan adds the mock server it needs, which also
exercises the management CLI. The router refuses to start with an empty
server list, so add a server before starting the router or an agent.

The add commands the plans use:

```bash
# stdio mock (runs inside the workspace)
pnpm qa:router add stdio-mock --description 'QA stdio mock' \
  -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts

# stdio mock with 200 extra bulk tools (the dynamic-limit plans)
pnpm qa:router add stdio-mock-bulk --description 'QA stdio bulk mock' \
  --compression-level low --env MOCK_EXTRA_TOOLS=200 \
  -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts

# streamable-http mock (runs in its own container)
pnpm qa:router add http-mock --description 'QA streamable-http mock' \
  http://mock-mcp-http:3100/mcp

# OAuth-protected streamable-http mock (auto-logs in via qa-browser)
pnpm qa:router add oauth-mock --description 'QA OAuth mock' \
  http://mock-mcp-http-oauth:3101/mcp
```

`pnpm qa:router list` shows the configured servers and their auth
status; `pnpm qa:router tools <name>` connects live and lists the
downstream tools.

## The mock LLM

`mock-llm` is a standalone container serving three APIs from one
scripted conversation store: the OpenAI-compatible chat completions API
(`GET /v1/models`, `POST /v1/chat/completions`), the OpenAI Responses
API (`POST /v1/responses`) used by Codex CLI, and the Anthropic
Messages API (`POST /v1/messages` plus its `count_tokens` probe), all
streaming and plain JSON. `pnpm qa:agent` points the selected coding
agent at it with a hermetic scratch configuration, so the tester's
global agent configuration, plugins, and MCP servers are ignored and the
QA router is the only MCP server in play:

- `--agent opencode` (default) writes
  `qa/fixtures/opencode/opencode.jsonc` into a scratch
  `XDG_CONFIG_HOME`.
- `--agent copilot` writes `qa/fixtures/copilot/mcp-config.json` into a
  scratch `COPILOT_HOME` and runs GitHub Copilot CLI in BYOK mode:
  `COPILOT_PROVIDER_BASE_URL` points at the mock LLM,
  `COPILOT_OFFLINE=true` keeps the CLI away from GitHub, and inherited
  GitHub tokens are removed, so no GitHub account or network access is
  needed.
- `--agent claude` writes `qa/fixtures/claude/mcp-config.json` into a
  scratch `CLAUDE_CONFIG_DIR` and runs Claude Code headless:
  `ANTHROPIC_BASE_URL` points at the mock LLM's Anthropic endpoint,
  `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` carry a dummy key, and
  telemetry and auto-updates are disabled, so no Anthropic account or
  network access is needed.
- `--agent codex` writes `qa/fixtures/codex/config.toml` into a scratch
  `CODEX_HOME` and runs Codex CLI headless: a custom model provider with
  `wire_api = "responses"` points at the mock LLM's Responses endpoint,
  `QA_MOCK_API_KEY` carries a dummy key, and the CLI runs with
  `--dangerously-bypass-approvals-and-sandbox` because the throwaway
  workspace container is the security boundary (Codex's Linux sandbox
  cannot run inside Docker), so no OpenAI account or network access is
  needed.

`pnpm qa:agent --mcp-list [--agent opencode|copilot|claude|codex]` runs
the agent's MCP listing command with the same hermetic configuration
instead of a session, which is how the discovery scenarios start.

### Scripts

A script is a list of assistant turns (a tool call or a final text) plus
the expectations for the request that triggers each turn. Select a
script with `pnpm qa:llm script <name>`; this resets the step and clears
the log. The built-ins are:

| Script | Conversation |
| --- | --- |
| `stdio-catalog` | Verify the two router tools and the stdio catalog, then reply with text |
| `stdio-roundtrip` | Read the `add` schema, invoke 20 + 22, expect 42 |
| `tool-list` | Call `get_tool_schema` without tool names, expect the signatures and hint back |
| `http-catalog` | Verify the two router tools and the http catalog, then reply with text |
| `http-roundtrip` | Read the `add` schema, invoke 20 + 22, expect 42 |
| `oauth-catalog` | Verify the two router tools and the oauth catalog, then reply with text |
| `oauth-roundtrip` | Read the `add` schema, invoke 20 + 22, expect 42 |
| `retry` | Invoke `add` with a missing argument, recover with the fixed call, expect 42 |
| `fail` | Invoke `failing_tool` and expect the downstream error to come back |
| `stdio-descriptions` | Verify every stdio tool description reaches the model as a first sentence (low compression) |
| `long-description` | Verify the catalog carries the `documented_tool` first sentence and the result the full description |
| `long-catalog-truncated` | Verify Claude Code truncates the over-long catalog description and drops the tail |
| `dynamic-limit-degraded` | Verify a length-limited client gets the catalog degraded to `max` and list mode still returns the bulk tools |
| `dynamic-limit-kept` | Verify a client outside the dynamic-limit list keeps the full catalog above the cap |

`pnpm qa:llm list` prints the same table. For ad-hoc scenarios,
`pnpm qa:llm custom <file.json>` installs an inline script with the same
shape (`{"name": ..., "steps": [...]}`).

### Validation checks

Before serving a step, the mock evaluates the request against that
step's expectations. Tool names are matched exactly or by `_`-separated
suffix, so `get_tool_schema` matches `qa-router_get_tool_schema`.

| Check | Verifies |
| --- | --- |
| `toolsContain` | The request's tool list contains the named tool |
| `toolsAbsent` | Downstream tools are not advertised directly to the model |
| `catalogIncludes` | The `get_tool_schema` description contains the substrings (catalog sections, tool lines) |
| `catalogExcludes` | The `get_tool_schema` description does not contain the substrings (for example the long-description tail, which Claude Code cuts at its 2048-character cap) |
| `messagesInclude` | The message history contains the substrings (tool results, guided errors) |
| `toolCallsInclude` | The recorded tool calls exist and their compact JSON arguments contain the substrings |

If a check fails, the mock does not advance the script and answers with
a `QA mock LLM validation failed:` text listing the failures.
`pnpm qa:agent` then exits 1, and `pnpm qa:llm log` shows the FAIL lines.

### Reading the log

```bash
pnpm qa:llm status      # current script, step, and request count
pnpm qa:llm log         # readable summary: tools, checks, responses
pnpm qa:llm log --raw   # complete raw request/response JSON
pnpm qa:llm reset       # step back to 0, log cleared
```

`pnpm qa:llm log` exits 1 when any check failed. The same log entries
are written to the mock container's stdout, so the raw traffic is also
visible from the host:

```bash
docker compose -f qa/docker-compose.yml logs mock-llm
```

The summary of one request shows the advertised tool list, every check
with PASS/FAIL, and the scripted response, for example:

```text
[request 3] main step 2/3
  tools (12): bash, edit, glob, grep, qa-router_get_tool_schema, qa-router_invoke_tool, read, skill, task, todowrite, webfetch, write
  PASS messagesInclude: inputSchema
  PASS toolCallsInclude: get_tool_schema
  PASS toolCallsInclude: get_tool_schema(stdio-mock)
  PASS toolCallsInclude: get_tool_schema(add)
  response (tool): tool qa-router_invoke_tool {"server":"stdio-mock","tool":"add","arguments":{"a":20,"b":22}}
```

## Mock MCP servers

| Server | Transport | Tools |
| --- | --- | --- |
| `qa/scripts/mock-mcp-stdio/` (in the workspace) | stdio | `echo`, `add`, `multi_block`, `failing_tool`, `documented_tool` |
| `mock-mcp-http` (own container) | streamable-http | The same five tools plus `whoami` |
| `mock-mcp-http-oauth` (own container) | streamable-http + bearer token | The same five tools plus `whoami` |

The shared tools live in `qa/scripts/mock-mcp-tools.ts`: `echo` returns
`echo: <message>` so a round trip is distinguishable from the request
arguments, `add` returns the sum, `multi_block` returns a text, a
resource, and a text block, `failing_tool` returns an `isError` result,
and `documented_tool` carries a deliberately long description (about
3.4 KB, bounded by the `LONG-DESCRIPTION-HEAD` and
`LONG-DESCRIPTION-TAIL` markers). The catalog only ever shows the
first sentence (the head marker); the description plans verify that the
complete text arrives through the `get_tool_schema` result.
`pnpm --silent qa:long-description` prints the same text for use as a
server's `--description`, which the Claude Code truncation plan uses to
grow the catalog past Claude Code's 2048-character tool-description cap.

The stdio mock also accepts `MOCK_EXTRA_TOOLS=<n>`, registering that
many extra `bulk_tool_###` tools after the standard five. The
dynamic-limit plans add it with `--env MOCK_EXTRA_TOOLS=200` (205 tools
total) so the catalog exceeds the 2048-character cap: the router
auto-degrades the catalog to `max` for Claude Code, while opencode and
Codex keep the configured level.

With `MOCK_MCP_AUTH=oauth`, the HTTP mock publishes mock OAuth metadata
(RFC 9728 + RFC 8414), supports dynamic client registration, and
auto-approves the authorization request, so the router's `login`
completes without a real browser. The OAuth container advertises itself
as `http://mock-mcp-http-oauth:3101`, the in-network name the router can
resolve. Its container log shows the authenticated tool calls:

```bash
docker compose -f qa/docker-compose.yml logs mock-mcp-http-oauth
docker compose -f qa/docker-compose.yml logs mock-mcp-http
```

## Gherkin plans

| Feature file | Group | Covers |
| --- | --- | --- |
| `router-startup.feature` | `STARTUP` | Two-tool surface, compact catalog, disabled servers |
| `tool-schema.feature` | `SCHEMA` | `get_tool_schema` results, list mode, and guided errors |
| `tool-invocation.feature` | `INVOKE` | `invoke_tool` round trips, error passthrough, validation |
| `cli-management.feature` | `CLI` | `list`, `tools`, and enable/disable |
| `http-server.feature` | `HTTP` | Adding a streamable-http server and its catalog |
| `oauth-server.feature` | `OAUTH` | Auto-login, logout, and login again |
| `compression.feature` | `COMPRESS` | The four catalog levels and list mode from a `max` server |
| `opencode.feature` | `OPENCODE` | Discovery, catalog, first-sentence descriptions, stdio/http/oauth round trips, recovery, cleanup, dynamic-limit scope |
| `copilot.feature` | `COPILOT` | The same checks for GitHub Copilot CLI (offline BYOK) |
| `claude.feature` | `CLAUDE` | Discovery, catalog, first-sentence descriptions, the long-description result path, the 2048-character truncation cap, auto-degradation, round trips, recovery, cleanup |
| `codex.feature` | `CODEX` | Discovery, catalog, first-sentence descriptions, the long-description result path, dynamic-limit scope, round trips, recovery, cleanup |

The steps are written as instructions for a human tester: each one
names the exact command to run or the exact evidence to look for. The
mock LLM log is the primary evidence; the agent transcript and the
container logs are secondary.

### Test IDs

Every `Scenario` and `Scenario Outline` carries exactly one ID tag of
the form `@TC-<GROUP>-<case>`, where GROUP is a semantic uppercase name
for the test area (e.g. `@TC-OPENCODE-1`). All scenarios in one file share
the same group, and IDs are unique across the suite.
`qa/scripts/bdd/check-gherkin-ids.ts` enforces exactly-one-ID, per-file
group consistency, and uniqueness.

### Linting

```bash
pnpm lint:gherkin
```

Runs the ID check plus `gherkin-lint` over `qa/features/` (style rules
in `qa/.gherkin-lintrc`). It is also chained into `pnpm lint`.

### Running

The runner records verdicts; it does not execute the steps for you.

```bash
pnpm qa:run                  # interactive: walk every scenario
pnpm qa:run --list           # print all scenario IDs and titles
pnpm qa:run --feature opencode  # only that file (substring match)
pnpm qa:run --id @TC-OPENCODE-3  # only that scenario
pnpm qa:run --auto-pass      # non-interactive: mark everything passed
pnpm qa:run --run-id <id>    # fixed run id instead of a timestamp
```

The runner prints each scenario and its steps, then accepts
`p`/`f`/`s`/`q` (pass / fail / skip / quit; anything else counts as
pass). After the verdict it asks for a description of what was done or
observed; the description is stored in the report together with the
verdict. `--auto-pass` skips both prompts.

Each run gets a unique run id: a local timestamp
(`2026-09-17T12-34-56`, with a numeric suffix on collision) or
`--run-id <id>`. Reports are written inside the workspace to
`qa/output/<run-id>/` as `report.json` and `report.md`, progressively,
so an interrupted run keeps its results. `qa/output` is a named volume,
so reports survive container recreation. Copy a report out from the
host before removing the volume:

```bash
mkdir -p qa/output
docker compose -f qa/docker-compose.yml \
  cp workspace:/app/qa/output/<run-id> qa/output/
```

## Rebuilding and troubleshooting

- Rebuild after any source or QA change:
  `docker compose -f qa/docker-compose.yml up -d --build`.
- Check the mocks are healthy:
  `docker compose -f qa/docker-compose.yml ps`.
- "No mock LLM script selected" from `pnpm qa:agent`: run
  `pnpm qa:llm list` and `pnpm qa:llm script <name>` first.
- `copilot` is missing or fails to start: the workspace image must
  contain `@github/copilot` (pinned in `qa/Dockerfile`); check with
  `pnpm qa:agent --agent copilot --mcp-list`. The plans never need a
  GitHub account because Copilot runs in offline BYOK mode.
- `claude` is missing or fails to start: the workspace image must
  contain `@anthropic-ai/claude-code` (pinned in `qa/Dockerfile`); check
  with `pnpm qa:agent --agent claude --mcp-list`. The plans never need an
  Anthropic account because Claude Code runs against the mock LLM's
  Anthropic endpoint.
- `codex` is missing or fails to start: the workspace image must contain
  `@openai/codex` (pinned in `qa/Dockerfile`); check with
  `pnpm qa:agent --agent codex --mcp-list`. The plans never need an
  OpenAI account because Codex CLI runs against the mock LLM's Responses
  endpoint with a dummy `QA_MOCK_API_KEY`. A sandbox error from Codex
  means the `--dangerously-bypass-approvals-and-sandbox` flag is missing
  from the runner; inside the workspace container that flag is required
  because Codex's Linux sandbox cannot run under Docker.
- The mock LLM log reports a failed `catalogExcludes` check in a
  `long-description` run: the catalog unexpectedly contains the tail
  marker. The router renders only the first sentence at `low`, so this
  usually means the selected script or the router build is stale.
- The router refuses to start with an empty server list: run
  `pnpm qa:setup` and add a server before `pnpm qa:probe` or an agent.
- `pnpm qa:llm log` exits 1 and shows FAIL lines: the agent did not
  send what the script expected. `pnpm qa:llm log --raw` has the
  complete request and response bodies.
- Start over cleanly: `docker compose -f qa/docker-compose.yml down`
  then `up -d --build`, and run `pnpm qa:setup` again.

The same Dockerfile provides a minimal runtime image:

```bash
docker build -f qa/Dockerfile --target router -t mcp-compress-router .
```

In a macOS sandbox VM the Docker engine runs on the host: the guest
drives it through the Docker CLI, and the stack uses named volumes and
no bind mounts, so it works unchanged in that setup. Host-port access
(the optional override) is reachable from the guest via the NAT gateway
(`http://192.168.64.1:<port>`), not `localhost`.

Any change to the stack (scripts, services, fixtures, commands) MUST
update this README in the same change.
