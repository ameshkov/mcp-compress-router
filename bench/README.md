# Benchmark harness

Docker-based benchmark that measures how much context (and money)
mcp-compress-router saves when a coding agent works next to several MCP
servers. It drives Claude Code (with MCP Tool Search on and off), Codex
CLI, GitHub Copilot CLI, OpenCode, and OpenCode V2 through the same
coding task in two modes —
the MCP servers connected directly, and the same servers connected
through the router — and reads the token usage back with
[ccusage](https://ccusage.com/).

## What it measures

Every run gets the same prompt (`bench/prompts/todo-app.md`: build a
TODO web app with a pinned Node.js stack, file layout, and test
command) and the same four mock MCP stdio servers, whose tool surfaces
are vendored from popular public servers:

| Mock server | Tools | Vendored surface |
| --- | --- | --- |
| `notion` | 12 | Notion MCP tool names and schemas |
| `github` | 20 | GitHub MCP server tool names and schemas |
| `figma` | 12 | Figma MCP tool names and schemas |
| `playwright` | 15 | Playwright MCP tool names and schemas |

The mock servers advertise realistic tool definitions and implement
nothing: every call returns a "not implemented" error and is appended to
an invocation log. The task never needs those tools, so the benchmark
isolates the *context overhead* of the tool listings — exactly what the
router removes.

Each agent runs in two modes:

- **direct** — the agent connects to all four mock servers itself.
- **router** — the agent connects only to mcp-compress-router, which
  connects to the same four servers and exposes its two routing tools.

Claude Code is measured twice with the same model: `claude` keeps the
default MCP Tool Search behavior (definitions deferred and discovered
on demand), and `claude-no-tool-search` forces
`ENABLE_TOOL_SEARCH=false` so every definition loads upfront. The pair
shows the router's effect with and without host-side deferral.

The harness records the `ccusage` token totals and cost, wall-clock
duration, agent steps (LLM turns), and mock MCP invocations, and the
report pairs the two modes per agent.

## Prerequisites

- Docker with Docker Compose v2 (`docker compose version`).
- Credentials for at least one of the agents (the two Claude Code
  measurements share one set).

Nothing else is needed on the host: every run happens inside the
benchmark images, and the stack publishes no host ports.

## Configure credentials

Credentials, base URLs, and model names travel through `bench/.env` as
`BENCH_*` variables; the harness maps them onto each agent's native
configuration inside the container. Only the variables of the agents you
run are required — a run fails fast with a message naming the missing
variable.

```bash
cp bench/.env.example bench/.env
# edit bench/.env
```

| Variable | Agent | Required | Purpose |
| --- | --- | --- | --- |
| `BENCH_CLAUDE_API_KEY` | Claude Code | one credential | Anthropic API key |
| `BENCH_CLAUDE_AUTH_TOKEN` | Claude Code | one credential | Gateway bearer token |
| `BENCH_CLAUDE_OAUTH_TOKEN` | Claude Code | one credential | Subscription token from `claude setup-token` |
| `BENCH_CLAUDE_BASE_URL` | Claude Code | no | Custom API endpoint |
| `BENCH_CLAUDE_MODEL` | Claude Code | yes | Main model id; append `[1m]` for the 1M-token context window |
| `BENCH_CLAUDE_SMALL_MODEL` | Claude Code | no | Small/fast model for background calls |
| `BENCH_CODEX_API_KEY` | Codex CLI | yes | Provider API key |
| `BENCH_CODEX_BASE_URL` | Codex CLI | no | Custom provider base URL (defaults to the OpenAI endpoint) |
| `BENCH_CODEX_MODEL` | Codex CLI | yes | Model id |
| `BENCH_CODEX_WIRE_API` | Codex CLI | no | Wire API (Codex supports only `responses`) |
| `BENCH_OPENCODE_API_KEY` | OpenCode (V1/V2) | yes | Provider API key |
| `BENCH_OPENCODE_BASE_URL` | OpenCode (V1/V2) | custom providers | Provider base URL |
| `BENCH_OPENCODE_MODEL` | OpenCode (V1/V2) | yes | `<provider>/<model>` reference |
| `BENCH_OPENCODE_NPM` | OpenCode (V1/V2) | no | Provider package for non-built-in providers |
| `BENCH_COPILOT_API_KEY` | Copilot CLI | yes | BYOK provider API key |
| `BENCH_COPILOT_BASE_URL` | Copilot CLI | yes | BYOK provider base URL |
| `BENCH_COPILOT_MODEL` | Copilot CLI | yes | Model id sent to the provider |
| `BENCH_COPILOT_WIRE_API` | Copilot CLI | no | `chat` (default) or `responses` |
| `BENCH_TIMEOUT_MS` | harness | no | Per-run timeout (default 30 minutes) |
| `BENCH_CCUSAGE_OFFLINE` | harness | no | `1` uses cached ccusage pricing only |
| `BENCH_RUNS_DIR` | harness | no | Run root (default `/bench/runs`) |
| `BENCH_PROMPT_FILE` | harness | no | Alternate task prompt inside the container |

Agent notes:

- Claude Code accepts an API key, a gateway bearer token, or a
  subscription OAuth token. When several are set, Claude Code applies
  its own precedence: bearer token, then API key, then OAuth token. The
  model id must be one Claude Code recognizes — it rejects unknown ids
  at startup with `unrecognized_model`, and a model can require a newer
  CLI than the image pins: Opus 5.5 needs Claude Code 2.1.280 or newer,
  and the image pins 2.1.283. The default `claude-opus-5-5[1m]` opts
  into the model's 1M-token context window, and
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000` pins the auto-compact
  trigger to the full window. Claude-specific variables that are not
  `BENCH_*` pass through to the CLI unchanged; this is also how
  `ENABLE_TOOL_SEARCH` is set. The `claude-no-tool-search` measurement
  overrides that passthrough and always runs with
  `ENABLE_TOOL_SEARCH=false`.
- Codex CLI always runs through a custom `wire_api = "responses"`
  provider — `BENCH_CODEX_BASE_URL` when set, the OpenAI endpoint
  otherwise — with `supports_websockets = false`. Newer models such as
  `gpt-5.6-sol` prefer the Responses API WebSocket transport, which
  authenticates from `$CODEX_HOME/auth.json` rather than an API-key
  environment variable, so the key-only built-in provider fails with
  `401 Unauthorized`; built-in provider IDs cannot be overridden, hence
  the custom provider.
- OpenCode built-in providers are `anthropic`, `openai`, `deepseek`,
  and `openrouter`. Any other provider needs `BENCH_OPENCODE_BASE_URL`
  and is declared with `BENCH_OPENCODE_NPM` (default
  `@ai-sdk/openai-compatible`). Built-in providers get an explicit model
  declaration, so ids their bundled catalog does not list (OpenRouter
  aliases) still resolve. The `opencode`
  agent targets V1 (`opencode-ai`) and writes the V1 config shape; the
  `opencode-v2` agent targets the separate `@opencode/cli` package
  (beta) and writes the native V2 shape, where MCP servers run through
  Code Mode by default.
- GitHub Copilot CLI runs in BYOK mode (`COPILOT_PROVIDER_*`) against
  `BENCH_COPILOT_BASE_URL` with `COPILOT_OFFLINE=true`, so it never
  contacts GitHub and needs no GitHub token; inherited `COPILOT_*`,
  `GH_TOKEN`, and `GITHUB_TOKEN` values are scrubbed. The provider type
  is `openai`. Chat Completions is the default wire API; set
  `BENCH_COPILOT_WIRE_API=responses` for endpoints or models that reject
  the CLI's custom tool entry on `/chat/completions` (OpenAI models such
  as `gpt-6-sol` do).

## Run the benchmark

From the repository root:

```bash
# Build the images (once, and after any source change)
pnpm bench:build

# All twelve runs (6 measurements x 2 modes) plus the report
pnpm bench:all

# One agent, both modes
pnpm bench:all -- --agents claude

# One run, directly
pnpm bench:claude -- --mode router
pnpm bench:claude-no-tool-search -- --mode direct
pnpm bench:codex -- --mode direct
pnpm bench:copilot -- --mode direct
pnpm bench:opencode -- --mode direct
pnpm bench:opencode-v2 -- --mode direct

# Report only
pnpm bench:report
```

`pnpm bench:all` options: `--agents`, `--modes`, `--timeout`,
`--offline`, `--skip-build`, `--skip-report`.

### Single-run options

The container entry point is `bench/scripts/run.ts`; `docker compose run`
appends its arguments to the image entry point:

| Option | Description |
| --- | --- |
| `--agent <name>` | `claude`, `claude-no-tool-search`, `codex`, `copilot`, `opencode`, or `opencode-v2` (set by the image) |
| `--mode <mode>` | `direct` or `router` |
| `--run-id <id>` | Explicit run id (default: timestamped) |
| `--timeout <ms>` | Agent timeout (default `BENCH_TIMEOUT_MS` or 30 minutes) |
| `--prompt <path>` | Alternate prompt file inside the container |
| `--offline` | Use cached ccusage pricing |

## How a run stays isolated

Every run gets its own container and its own run directory:

```text
/bench/runs/<agent>-<mode>-<timestamp>-<suffix>/
├── workspace/             # agent working directory (the TODO app)
├── home/                  # hermetic HOME: agent config + usage data
├── agent-config/          # generated MCP configuration for this run
├── router-home/mcp.json   # router mode: the four downstream servers
├── events.ndjson          # raw agent event stream
├── mcp-invocations.ndjson # mock MCP calls (should stay empty)
├── summary.json           # metrics; the report reads these
└── meta.json              # run manifest for debugging
```

- A fresh container per run (`docker compose run --rm`), so filesystem,
  processes, and agent state start clean.
- A fresh `HOME` per run, plus a hermetic `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, `COPILOT_HOME`, or `XDG_CONFIG_HOME` + `XDG_DATA_HOME`,
  so no host or previous-run session leaks in.
- A fresh workspace per run; agents never see each other's work.
- `ccusage` reads exactly the run's hermetic home, so the totals belong
  to that run alone.

## Read the results

```bash
pnpm bench:report
```

The report prints a table (agent, mode, model, total/input/cache-read/
cache-create/output tokens, cost, duration, steps, mock MCP calls,
status) and writes `report.md` and `report.json` into the runs volume.
The "router effect" section pairs direct and router totals per agent and
shows the deltas, a tokens-per-step table shows the average context per
LLM turn, and a token-distribution table breaks the totals into input,
cache-read, cache-create, and output tokens per mode. The comparison
tables average only completed runs with usage data: a timed-out, failed,
or usage-less run still appears in the runs table with its status, but
it does not contribute to the deltas. A *step* is one
LLM turn, not one tool call: Claude Code and GitHub Copilot CLI are
counted by unique assistant message id, OpenCode by `step_finish`
events, and Codex by completed reasoning and answer items (its stream
has no per-turn event). Costs are ccusage's API-equivalent estimates,
not billing.

What an agent sends depends on the agent, not on the router. Claude
Code's MCP Tool Search defers MCP tool definitions, so in direct mode
its listings cost only a small search index instead of the full schemas;
Tool Search is on by default against the first-party Anthropic API and
off by default when `ANTHROPIC_BASE_URL` points to a non-first-party
host (most proxies do not forward the required beta), while
`ENABLE_TOOL_SEARCH=true` forces it on and `false` disables it. OpenCode
V1 and GitHub Copilot CLI send every definition on every request, so
they show the full per-step difference. OpenCode V2 runs MCP servers
through Code Mode by default, so their tools reach the model through a
script runtime instead of the native tool list, and the router's saving
disappears. Codex CLI 0.156.1 gives `gpt-6-sol`
the catalog's `code_mode_only` tool mode: the agent works through a
code-mode `exec` tool and the MCP tools sit behind a lazy `tool_search`
index rather than the definitions, so direct and router runs start from
the same context (~10.8k) and average the same input per LLM call
(~13.1k) — the router's per-turn effect there is negligible. The
total-token difference in the table comes from run-to-run variation in
how many turns the agent takes, not from tool overhead. To measure the
definitions-loaded case for Claude Code, run the
`claude-no-tool-search` measurement, which forces
`ENABLE_TOOL_SEARCH=false` for that run; setting the variable in
`bench/.env` changes the default `claude` measurement instead.
`ENABLE_TOOL_SEARCH=auto`
defers only when the deferrable definitions reach 10% of the context
window — 100K tokens with the default `claude-opus-5-5[1m]` — so the
bench's 59 mock tools load upfront under `auto`.

To inspect a single run inside the volume:

```bash
docker compose -f bench/docker-compose.yml run --rm --entrypoint sh report \
  -c 'cat /bench/runs/<run-id>/summary.json'
```

## Results

Averages over 3 runs per mode for every measurement, from one campaign
on 2026-09-27 (`claude-opus-5-5[1m]` on Claude Code 2.1.283 for both
Claude Code measurements, with `ENABLE_TOOL_SEARCH` unset for `claude`
and `false` for `claude-no-tool-search`; and `openai/gpt-6-sol` for
every other agent — directly on Codex CLI 0.156.1, through OpenRouter
for Copilot CLI, OpenCode, and OpenCode V2, with automatic prompt
caching):

| Coding agent | Mode | Steps | Input | Cache read | Cache create | Output | Total tokens | Tokens/step | Cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude Code (Tool Search on) | direct | 3.0 | 6 | 43,117 | 10,690 | 4,500 | 58,312 | 19,437 | $0.1842 |
| Claude Code (Tool Search on) | router | 3.0 | 6 | 42,963 | 10,060 | 4,651 | 57,680 | 19,227 | $0.1821 |
| Claude Code (Tool Search off) | direct | 3.0 | 6 | 106,483 | 9,868 | 4,576 | 120,933 | 40,311 | $0.1918 |
| Claude Code (Tool Search off) | router | 3.0 | 6 | 68,807 | 9,509 | 4,241 | 82,563 | 27,521 | $0.1747 |
| Codex CLI | direct | 3.3 | 13 | 42,102 | 15,903 | 5,057 | 63,074 | 18,922 | $0.0988 |
| Codex CLI | router | 3.3 | 13 | 42,266 | 15,263 | 4,317 | 61,858 | 18,557 | $0.0898 |
| Copilot CLI | direct | 8.0 | 22 | 108,716 | 20,018 | 4,566 | 133,322 | 16,665 | $0.0587 |
| Copilot CLI | router | 6.0 | 15 | 47,522 | 14,948 | 4,546 | 67,030 | 11,172 | $0.0462 |
| OpenCode | direct | 6.7 | 20 | 73,013 | 15,589 | 3,480 | 93,067 | 13,960 | $0.0490 |
| OpenCode | router | 6.0 | 18 | 40,742 | 10,618 | 3,339 | 55,997 | 9,333 | $0.0405 |
| OpenCode V2 | direct | 3.3 | 13 | 24,979 | 18,713 | 3,347 | 47,709 | 14,313 | $0.0833 |
| OpenCode V2 | router | 3.7 | 14 | 29,038 | 18,714 | 3,390 | 51,825 | 14,134 | $0.0848 |

| Coding agent | Total token savings | Per-turn context savings | Cost savings |
| --- | ---: | ---: | ---: |
| Claude Code (Tool Search on) | 1.1% | 1.1% | 1.1% |
| Claude Code (Tool Search off) | 31.7% | 31.7% | 8.9% |
| Codex CLI | 1.9% | 1.9% | 9.1% |
| Copilot CLI | 49.7% | 33.0% | 21.4% |
| OpenCode | 39.8% | 33.1% | 17.5% |
| OpenCode V2 | -8.6% | -1.2% | -1.8% |

Negative savings mean the router mode used more. gpt-6-sol varies its
turn count (Copilot CLI averages eight direct turns against six router
turns, OpenCode 6.7 against 6.0), so the total-token column is partly a
turn-count signal and the per-turn column is the stable one. The two
Claude Code measurements show both regimes side by side: with Tool
Search on the router removes only the deferred-name index, so per-turn
context barely moves (1.1% savings); with Tool Search off every
definition is loaded on every turn, and the router cuts per-turn context
by 31.7%. Copilot CLI and OpenCode V1, which also load definitions
upfront, drop by 33.0% and 33.1% per turn.

Codex CLI is flat: code mode sends much the same tool surface in both
modes, so its 1.9% per-turn saving is run-to-run variance. OpenCode V2
is flat for the same structural reason: its Code Mode defers the MCP
tools, so both modes start level and the router adds about as much
context as it removes (1.2% regression).

Costs come from each agent's own accounting: OpenCode (V1 and V2)
records the cost OpenRouter reports per request, while `ccusage`
estimates the others from its pricing tables, so cross-agent cost
comparisons are approximate — V1 and V2 report the same model
differently, so compare costs within an agent, not across. Cost savings
depend on the token mix: output tokens cost several times more than
cached input, so removing cached context saves much less per token than
removing output. Codex CLI shows that in reverse — 1.9% fewer tokens but
9.1% lower cost, because its router runs emitted 14.6% fewer output
tokens. Claude Code (Tool Search off) shows the usual direction: 31.7%
fewer tokens but 8.9% lower cost, because most of what the router
removes is cache reads.

For Claude Code, the router's token savings depend on whether Tool
Search is active:

- **On** (the default when Claude Code talks to the first-party
  Anthropic API): the MCP schemas are already deferred, so the router
  only trims the deferred-tool index and its per-turn saving is small.
- **Off** (`claude-no-tool-search`, or any host that disables it): every
  MCP definition is loaded on every turn, and the router recovers most
  of that context.

Claude Code disables Tool Search by default when `ANTHROPIC_BASE_URL`
points to a non-first-party host (a gateway or proxy), and
`ENABLE_TOOL_SEARCH=false` disables it explicitly;
`ENABLE_TOOL_SEARCH=true` forces it on where the endpoint supports it.

In short, the router pays off most where the agent loads tool
definitions upfront — OpenCode V1, GitHub Copilot CLI, or Claude Code
with Tool Search off. Hosts with native deferral (Claude Code with Tool
Search on, Codex CLI 0.156.1 with `gpt-6-sol`, OpenCode V2 with Code
Mode) still get the other router benefits (one stable catalog,
per-server tool filtering, OAuth handling). The task is short, so the
listing overhead is amortized over few turns — longer sessions with more
MCP servers save proportionally more. For the cost model behind these
numbers, see
[About token overhead](../docs/explanation/token-overhead.md).

## Layout

```text
bench/
├── Dockerfile           # build/router base + claude, codex, copilot, opencode, opencode-v2 targets
├── docker-compose.yml   # one service per measurement plus the report service
├── .env.example         # credential and harness variable template
├── prompts/             # the coding task prompt
└── scripts/
    ├── run.ts           # one isolated run (container entry point)
    ├── run-all.ts       # host-side orchestrator: build, all runs, report
    ├── report.ts        # comparison report
    ├── usage.ts         # ccusage invocation and JSON parsing
    ├── comparison.ts    # direct-vs-router delta logic
    ├── agent/           # process helpers and agent event transcripts
    ├── configs/         # per-agent config and credential adapters
    └── mock-mcp/        # mock stdio servers and vendored tool surfaces
```

## Adding another agent

A new agent is a full-stack change:

1. A config adapter in `bench/scripts/configs/` that maps the `BENCH_*`
   variables onto the agent's native config and hermetic home, plus the
   new name in `BenchAgent` and `ALL_AGENTS`
   (`bench/scripts/configs/types.ts`), which drive validation,
   orchestration, and the report.
2. A transcript handler in `bench/scripts/agent/transcript.ts` and a
   branch in `bench/scripts/agent/run-agent.ts`.
3. A stage in `bench/Dockerfile` (`FROM router AS <agent>`) with a pinned
   install and an entry point, plus a service in `bench/docker-compose.yml`
   and a `bench:<agent>` script in `package.json`.
4. A ccusage data source mapping in the adapter (`usageEnv` /
   `usageSource`) so the report can read its usage.
5. Unit tests and the updates to this README.

A measurement variant of an existing agent (for example Claude Code
with Tool Search off) reuses the agent's adapter and image: add the
`BenchAgent` name and `ALL_AGENTS` entry, branch the adapter on it to
force the differing environment, and add the Compose service,
`package.json` script, tests, and README updates. No new Dockerfile
stage or transcript handler is needed.

## Troubleshooting

- **`Missing bench/.env`** — copy `bench/.env.example` to `bench/.env`
  before running anything through Compose.
- **`Missing BENCH_<AGENT>_...`** — the run's agent has no credentials;
  fill in that agent's variables in `bench/.env`.
- **`unrecognized_model`** — Claude Code does not know the model id;
  set `BENCH_CLAUDE_MODEL` to a model it accepts.
- **Copilot CLI `400 Provider returned error`** — the endpoint rejected
  the CLI's custom tool entry on `/chat/completions`; set
  `BENCH_COPILOT_WIRE_API=responses`.
- **`Usage unavailable`** — the agent failed before writing usage data;
  inspect `events.ndjson` in the run directory.
- **Stale images after a source change** — run `pnpm bench:build`
  again; the images bake the repository.
- **A run takes too long** — lower `--timeout` or `BENCH_TIMEOUT_MS`.
- **The Docker engine runs outside this checkout** — the stack uses
  named volumes and no host ports, so it works unchanged; `report`
  reads the volume, not the host filesystem.

## Keeping this README in sync

`bench/README.md` is the guide for the benchmark stack. Any change to
the stack (scripts, environment variables, images, compose services, or
prompts) MUST update this README in the same change.
