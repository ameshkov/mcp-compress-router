# AGENTS.md

MCP Compress Router — a single-router MCP server that compresses all
connected MCP servers into one, with just two tools: `get_tool_schema` and
`invoke_tool`. Saves up to 99% on token overhead by replacing verbose
tool listings with a compact routing layer.

## Table of Contents

- [Project Overview](#project-overview)
- [Technical Context](#technical-context)
- [Project Structure](#project-structure)
- [Build and Test Commands](#build-and-test-commands)
- [Contribution Instructions](#contribution-instructions)
- [Code Guidelines](#code-guidelines)
    - [Architecture](#architecture)
    - [Code Quality](#code-quality)
    - [Testing](#testing)
    - [Manual QA](#manual-qa)
    - [Benchmarks](#benchmarks)
    - [Dependency Management](#dependency-management)
    - [Configuration & Documentation](#configuration--documentation)

## Project Overview

A single MCP (Model Context Protocol) server that acts as a router. Instead
of sending all tool names and descriptions from every connected MCP to the
LLM on every request, this server exposes only two tools:

- **`get_tool_schema`** — returns the JSON parameter schema for one or more
  tools on a connected MCP server, or lists a server's tools and their
  argument signatures when called without tool names.
- **`invoke_tool`** — forwards a tool invocation to a connected MCP server
  and returns the result.

The LLM first calls `get_tool_schema` to learn the parameters, then calls
`invoke_tool` to execute. This reduces token overhead by ~96% for a typical
coding session with 3 MCP servers.

## Technical Context

| Field | Value |
| --- | --- |
| Language | TypeScript 5.9, ES2022 target, strict mode |
| Runtime | Node.js 24+ |
| Package Manager | pnpm 10+ |
| Framework | MCP SDK (`@modelcontextprotocol/sdk`) |
| Linting | oxlint (category-based config) + Knip |
| Formatting | Prettier 3.x, Markdownlint (markdownlint-cli2) |
| Project Type | MCP server (stdio transport) |

## Project Structure

The repo is organized as a small set of modules, each owning one concern:

```text
mcp-compress-router/
├── src/                  # Application source code
│   ├── index.ts          # Entry point: stdio transport + CLI dispatch
│   ├── cli/              # Management CLI module: config I/O, subcommands
│   │                     #   (add/remove, enable/disable, get/list, tools,
│   │                     #   login/logout), router startup orchestration
│   ├── services/         # Core business logic module: config loading,
│   │                     #   downstream discovery and connection lifecycle,
│   │                     #   catalog, invoke recovery, OAuth, shutdown
│   ├── tools/            # Router tool handlers: get_tool_schema, invoke_tool
│   └── utils/            # Shared utility module: parsing, validation,
│                         #   filtering, formatting, atomic file writes,
│                         #   timeouts, logging, process-tree termination
├── test/                 # Test support: reusable fixture downstream MCP
│                         #   servers (stdio, HTTP, auth) and browser mock
│   └── e2e/              # End-to-end tests against the compiled router
├── qa/                   # Manual QA stack: Gherkin plans, verdict runner,
│                         #   compose stack + Dockerfiles (plus the opt-in
│                         #   host-ports override), mock LLM, mock MCP
│                         #   servers (stdio, streamable-http, OAuth) and
│                         #   the lifelike weather tool set, router/agent
│                         #   tooling (opencode, Copilot CLI, Claude Code,
│                         #   Codex CLI), opt-in real-LLM runs, baseline
│                         #   config
├── bench/                # Token-overhead benchmark harness: per-agent
│                         #   Docker images (Claude Code, Codex CLI,
│                         #   GitHub Copilot CLI, OpenCode, OpenCode V2)
│                         #   on a shared router base, mock MCP servers
│                         #   vendored from Notion/GitHub/Figma/Playwright
│                         #   tool surfaces, direct-vs-router runs, ccusage
│                         #   token and cost reports
├── .agents/skills/       # Project skills: manual test run, QA planning
├── docs/                 # Documentation
│   ├── reference/        # Configuration and CLI reference
│   ├── explanation/      # Token overhead, architecture, process
│   │                     #   lifecycle, development practices
│   ├── guides/           # Task guides: agent setup, OAuth, releasing
│   └── assets/           # Images and example payloads
├── DEVELOPMENT.md        # How to run and debug the project locally
├── mcp.example.jsonc     # Example JSONC config template (committed)
├── .env.example          # Environment variable template (committed)
├── .github/workflows/    # CI quality gate, canary and release npm publishes
└── package.json          # Dependencies and scripts
```

Root-level build and tooling configuration (`tsconfig.*.json`,
`oxlint.config.ts`, `knip.config.ts`, `vitest.config.ts`, Prettier and
Markdownlint settings) is intentionally left out of the tree.

Every source directory exposes its public API through an `index.ts`
barrel, and unit tests are co-located with the modules they cover (see
[Testing](#testing)).

The manual QA stack and the benchmark harness are documented in
[qa/README.md](./qa/README.md) and
[bench/README.md](./bench/README.md).

## Build and Test Commands

- `pnpm build` — compile TypeScript to `build/` and make executable
- `pnpm typecheck` — check for TypeScript type errors in production
  and test code
- `pnpm lint` — lint source and QA files with oxlint, check for unused
  exports with Knip, and validate the Gherkin plans (`lint:gherkin`)
- `pnpm lint:fix` — lint and auto-fix issues
- `pnpm lint:gherkin` — check the `@TC-*` test IDs and Gherkin style
- `pnpm knip` — run Knip unused-export analysis separately
- `pnpm format:check` — check formatting with Prettier and Markdownlint
- `pnpm format:fix` — fix formatting issues
- `pnpm check` — run `format:check`, `lint`, `typecheck`, `build`, and
  `test` (full CI gate)
- `pnpm clean` — remove `node_modules` and `build/`

## Contribution Instructions

You MUST follow the following rules for EVERY task that you perform:

- You MUST verify it with linter, formatter, and TypeScript compiler.

  Use the following commands:
    - `pnpm typecheck` to check for TypeScript type errors
    - `pnpm lint` to run the linter (oxlint) and Knip unused-export
      analysis
    - `pnpm lint:fix` to fix linting issues that can be fixed
      automatically
    - `pnpm format:check` to check the formatting (Prettier and Markdownlint)
    - `pnpm format:fix` to fix the formatting issues

- When making changes to the project structure, ensure the Project
  Structure section in `AGENTS.md` is updated and remains valid.

- If the prompt essentially asks you to refactor or improve existing code,
  check if you can phrase it as a code guideline. If it's possible, add it
  to the relevant Code Guidelines section in `AGENTS.md`.

- You MUST update the unit tests for changed code.

- You MUST run tests with the `pnpm test` script to verify that your
  changes do not break existing functionality.

- After completing the task you MUST verify that the code you've written
  follows the Code Guidelines in this file.

- If `CHANGELOG.md` exists, you MUST add an entry under `[Unreleased]`
  for every observable change — one a user of the project can notice, not
  just an edit inside the repository, such as formatting, lint, or tests —
  as part of the same change.

## Code Guidelines

The rules below are normative. For the reasoning behind them, see
[About the architecture](./docs/explanation/architecture.md),
[About the process lifecycle](./docs/explanation/process-lifecycle.md),
and
[About development practices](./docs/explanation/development-practices.md).

### Architecture

Universal design principles this codebase follows:

- **Separation of Concerns** — each module handles one aspect of the
  system (e.g., `services/` for business logic, `utils/` for shared
  helpers).
- **Single Responsibility Principle** — every file, class, or function has
  one reason to change.
- **Dependency Direction** — dependencies point downward; never from lower
  layers to higher ones.
- **Explicit Boundaries** — module interfaces are intentional; barrel
  `index.ts` files define public API. External code MUST import from
  barrel files only. Each directory groups related functionality and
  imports only from layers below it.
- **Data Flow Clarity** — data moves through the system in a predictable,
  traceable path (entry point → tool handler → service → utility).
- **Minimize Coupling, Maximize Cohesion** — modules are self-contained
  and interact through narrow interfaces.
- **Make Invalid States Impossible** — use TypeScript strict mode and
  validation to prevent illegal combinations at compile time.
- **Bounded Startup Latency** — network-bound startup phases (e.g.
  downstream connects and OAuth metadata probes) MUST run concurrently,
  never stacked sequentially, and each default timeout MUST stay well
  below the host's startup budget (typically 30 s) so a hung downstream
  dependency degrades fast instead of blocking initialization. Every
  await in the connect phase MUST be bounded, including the ones the
  SDK leaves unbounded: the stdio child-process spawn, the HTTP SSE
  session GET, and the OAuth metadata/token handshakes (bounded at the
  response-header phase only — long-lived SSE bodies and long-running
  tool-call POSTs must NOT be capped).
- **Host first, downstream second** — the router MUST answer the host's
  `initialize` before any downstream has connected, and MUST install its
  shutdown triggers (stdin EOF / signals) and connection-cleanup hook
  before spawning ANY downstream child. A host disconnect mid-connect
  must terminate the in-flight children rather than orphan them;
  `tools/list` and tool calls wait for discovery (bounded by the
  per-server connect timeouts, aborted on shutdown) so the compact
  catalog always reflects the final discovery state.
- **Resource-bound OAuth** — every OAuth request the router makes
  (authorization, code exchange, proactive refresh) MUST carry the
  RFC 8707 `resource` indicator whenever the downstream server
  publishes RFC 9728 Protected Resource Metadata, selected through the
  SDK's `selectResourceURL` so the CLI login, proactive refresh, and
  the SDK's own `auth()` path agree on the value. Omitting it breaks
  providers that bind tokens to a server: they reject the request with
  `invalid_target`.
- **Keep It Boring** — prefer well-understood patterns over clever or
  novel solutions.

The project is organized as a layered architecture. This project's
layers, from top to bottom:

- **Entry point** (`src/index.ts`) — initializes the MCP server, wires
  dependencies, registers tool handlers, and starts the stdio transport.
- **Tool handlers** (`src/tools/`) — MCP tool implementations. Parse
  tool parameters, delegate to core services, and format responses. No
  business logic here.
- **Core services** (`src/services/`) — own all business logic: catalog
  building, downstream server connection and discovery, configuration
  loading.
- **Utilities** (`src/utils/`) — shared helpers, renderers, and type
  definitions. No business logic.

```text
Entry point (index.ts)
     ↓
Tool handlers (tools/)
     ↓
Core services (services/)
     ↓
Utilities (utils/)
```

Tool handlers may call core services. Core services may use utilities.
No layer may depend on a layer above it.

**Tool handlers receive only the catalog**: The entry point creates the
catalog from discovered servers and injects it into tool handlers. Tool
handlers MUST NOT receive transport clients, raw server connections, or
configuration objects. See
[About the architecture](./docs/explanation/architecture.md).

**Keep the static catalog minimal**: The `get_tool_schema` description
is the only part of the router a host sends on every request, so it MUST
render every server that advertises tools in its smallest useful form:
one `- name (N tools) - description` bullet per server, an indented
status line when the server is degraded, and a closing list-mode hint
naming the first advertised server. Servers without tools MUST NOT be
advertised. Tool names, argument signatures, and tool descriptions MUST
NOT appear in the catalog; they belong to dynamic results (the
`get_tool_schema` list mode and schema results). The catalog format MUST
NOT become per-server configurable: one compact format for every server
is what keeps the token overhead predictable. See
[About token overhead](./docs/explanation/token-overhead.md).

**Own your process lifecycle**: The long-running router entry point is
responsible for shutting itself down, not the host. It MUST wire a
`ShutdownCoordinator` that registers cleanup hooks for every spawned
resource (each `ServerConnection`, the MCP server), install
`installShutdownTriggers` to trip the coordinator on signal or stdin
EOF, await `whenShutdown()` so the process stays alive while serving
and exits the moment cleanup finishes, and force-exit (`process.exit`)
afterwards so lingering grandchild pipes cannot trap it. Any new
long-running entry path or spawned resource MUST register a cleanup
hook. A stdio cleanup hook MUST terminate the whole process tree
(`killProcessTree`) — the SDK signals only the direct child — and MUST
await the transport close even when the SDK starts it fire-and-forget
after a failed handshake. See
[About the process lifecycle](./docs/explanation/process-lifecycle.md).

### Code Quality

All code MUST meet documentation and style requirements before merge:

- **Public API documentation**: Exported functions, classes, interfaces,
  and their properties MUST have JSDoc comments describing purpose,
  arguments, return values, and thrown errors (use `@throws` only for
  specific errors).
- **Static analysis gates**: Every change MUST pass TypeScript compilation
  (`pnpm typecheck`), oxlint (`pnpm lint`), and Prettier/Markdownlint
  (`pnpm format:check`) before merge.
- **Do not modify linter or formatter configurations**: Never change
  oxlint, Prettier, Markdownlint, or TypeScript configuration files
  (`oxlint.config.ts`, `.prettierrc`, `.prettierignore`,
  `.markdownlint-cli2.yaml`, `tsconfig.json`) to work around lint or
  formatting errors. Fix the source code instead. If the issue cannot be
  resolved after a few attempts, ask the human for help.
- **oxlint category selection**: oxlint groups rules into categories
  rather than a single `recommended` preset. This project enables only the
  `correctness` category (error) plus explicit project rules
  (`no-unused-vars`, `max-lines`, `max-lines-per-function`,
  `preserve-caught-error`). The `suspicious`, `restriction`, `pedantic`,
  and `style` categories, and the `unicorn` plugin, are intentionally
  disabled: they forbid idiomatic TypeScript (async/await, optional
  chaining, object spread, `undefined`) and the project's `_`-prefixed
  private-field convention — none of which the previous ESLint setup
  enforced. Do not re-enable these without explicit justification.
- **Error handling strategy**: Prefer throwing errors over returning error
  values. Handle errors at top-level entry points where they can be logged.
- **Atomic file writes**: Runtime state files (`mcp.json`,
  `credentials.json`, `tools-cache.json`) MUST be written through the
  shared `atomicWriteFile` helper (temporary sibling + rename), never
  with a bare `fs.writeFile`, so a crash or a concurrent writer can
  never leave a torn or empty file behind. Pass the file's mode
  explicitly when permissions must survive the rewrite.
- **Import style**: Use top-level static `import` statements exclusively.
  Do NOT scatter dynamic `await import()` calls inside function bodies
  ("inline imports"). Dynamic imports placed mid-function obscure
  dependencies, bypass static analysis, and fragment module initialization
  across call sites. When a dynamic import is genuinely necessary (e.g.,
  breaking a circular dependency or deferring a heavy module load for
  startup performance), extract it into a named, cached helper function at
  module scope (e.g., `getSdkAuth()`) rather than invoking `await import()`
  inline within business logic.
- **File naming**: Use kebab-case for all file names. TypeScript source
  files MUST use lower-case kebab-case. Do NOT use PascalCase or camelCase
  file names.
- **Knip unused-export analysis**: The project uses Knip
  (`knip.config.ts`) to detect unused exports. All Knip findings MUST
  be resolved — either remove the unused export or, when the export is
  genuinely needed but not reachable through the public dependency
  graph, mark it with the JSDoc `@internal` tag. The `@internal` tag
  is allowed **only** when a symbol is exported solely for test files
  and is intentionally **not** re-exported from the module barrel.
  Every `@internal` tag MUST include a short explanation of why the
  export is excluded (e.g., "Exported for tests only; not part of the
  public module API"). Do NOT use `@internal` to silence legitimate
  unused-export warnings — remove the export instead.
- **No `@public` tag**: Do NOT use the `@public` JSDoc tag. This
  project is an application (not a library), so no symbol is part of a
  "public API" consumed by external consumers. Resolve Knip
  unused-export findings by removing the export or marking it
  `@internal` (for test-only symbols not re-exported from the barrel)
  instead.
- **File size limit**: Source files MUST stay within 300 lines of code.
  This is an enforced oxlint `max-lines` gate (`'error'` severity,
  `max: 300`; blank lines and comments are skipped) — a hard gate, not a
  soft target. When a file approaches or exceeds this limit, your FIRST
  and default response MUST be
  to **split the file into several smaller, cohesive files**, each with a
  single, clear responsibility (extract related functions, types, or
  constants into dedicated modules, utilities, or services, and
  re-export them through the barrel). Treat the limit as a signal that
  the file is doing too much, not as a quota to optimize against. You
  MUST attempt a split before any other tactic; only fall back if you can
  articulate a concrete reason a split would hurt clarity.
  For test files, the `max-lines` gate is raised to 500 (and
  `max-lines-per-function` is disabled); split a large `*.test.ts` into
  multiple focused `*.test.ts` files grouped by the behavior they
  verify — multiple test files per source module are explicitly allowed.
  **Do NOT** satisfy the limit by making the existing code shorter: no
  condensing tests into table-driven blocks purely to save lines, no shortening
  of identifiers, string literals, or file paths, no merging statements onto one
  line, and no removing blank lines, comments, or JSDoc. Formatting is managed
  by Prettier and must stay uniform — readability and clarity always win over
  line count.
  Exceptions: auto-generated files and database migration files.
- **Function size limit**: Functions SHOULD stay within 50 lines of code.
  When approaching or exceeding this limit, break the function into
  smaller, named helper functions with single, clear responsibilities.
  **Do NOT** condense logic into dense one-liners, inline multiple
  statements on a single line, or strip whitespace to fit the limit —
  formatting is managed by Prettier and must not be sacrificed for
  brevity.
  Exceptions: auto-generated files and database migration files.

### Testing

Every module MUST have test coverage:

- **Test file placement**: Test files are co-located with their source
  files in `src/` and MUST use the `.test.ts` suffix (e.g.,
  `src/config.test.ts` next to `src/config.ts`).
- **Shared test utilities**: Common test infrastructure lives in the
  `test/` directory (fixture servers, setup helpers). These files MUST
  NOT use the `.test.ts` suffix — they are test support code, not test
  cases.
- **End-to-end tests**: E2E tests live in `test/e2e/`. They exercise
  the full compiled router as a child process over stdio using the MCP
  JSON-RPC protocol.
- **Test verification mandatory**: All changes MUST pass `pnpm test`
  before merge. Tests MUST NOT be deleted or weakened without explicit
  justification.
- **Use real integrations where practical**: Integration and E2E tests
  use a fixture MCP server (`test/fixture-server.ts`) that simulates a
  real downstream MCP server over stdio transport. Prefer
  integration-style tests that exercise real components over
  mock-heavy unit tests.

### Manual QA

Manual testing runs through the QA stack in `qa/`; its services,
commands, and plans are documented in
[qa/README.md](./qa/README.md).

- **Run manual tests in the QA workspace**: the `pnpm qa:*` scripts and
  the plans execute inside the Compose workspace, never from a host
  checkout, and the stack is rebuilt after any source or QA change.
- **Keep host access opt-in**: the stack publishes no host ports by
  default; use `qa/docker-compose.host-ports.yml` only when a test needs
  host access.
- **Write plans as human instructions**: every scenario names the exact
  command to run and the exact evidence to look for, and never relies on
  the runner or hidden automation to perform a step.
- **Treat the mock LLM log as the primary evidence**: for the scripted
  plans, verify new or changed agent-observable behavior through its
  log; agent transcripts and container logs are supporting channels.
  The opt-in real-LLM plans have no mock LLM log — there the transcript
  and the mock MCP server logs are the evidence.
- **Pass real-LLM credentials only through `qa/.env`**: the opt-in
  `pnpm qa:agent --real-llm` plans read `QA_OPENROUTER_API_KEY` and
  `QA_REAL_LLM_MODEL` from it; never commit it, and keep
  `qa/.env.example` current.
- **Write real-LLM plans as lifelike tasks**: a real-LLM prompt MUST
  describe an ordinary user task and never name a tool; give the model a
  mock server whose tools fit the task and verify through the transcript
  and the downstream call log that the model found and actually used it.
- **Keep plans and docs in sync**: adding, changing, or removing
  observable behavior MUST update the corresponding
  `qa/features/*.feature` plans, and any stack change MUST update
  `qa/README.md`, in the same change.
- **Use the QA skills**: `manual-test-run` drives a session and records
  verdicts; `qa-test-planning` maps a changeset to plan coverage.
- **Adding a coding agent is a full-stack change**: add a runner and a
  transcript renderer in `qa/scripts/agent/`, a hermetic fixture, a
  pinned install, a feature plan, and the README updates; extend the
  mock LLM with a `ProtocolAdapter` for a new wire protocol instead of
  adding a translation proxy.

### Benchmarks

The token-overhead benchmark harness lives in `bench/`; its images,
environment variables, commands, and reports are documented in
[bench/README.md](./bench/README.md).

- **Run benchmarks in the images**: use `pnpm bench:all` or
  `pnpm bench:<agent>` (Compose `run`), never a host checkout, and
  rebuild after any source or bench change.
- **Keep every run isolated**: each run gets a fresh container and run
  directory with its own workspace, hermetic home, agent config, and
  router home; never reuse run state across runs.
- **Pass credentials only through `bench/.env`**: never commit it, and
  keep `bench/.env.example` current.
- **Never implement the mock MCP servers**: they exist to reproduce
  realistic tool-definition overhead; do not add behavior to them or
  make the task prompt depend on them.
- **Keep `bench/README.md` in sync**: any change to the stack updates it
  in the same change.
- **Adding a coding agent is a full-stack change**: add a config
  adapter, a transcript handler, a Dockerfile stage, a Compose service,
  a `package.json` script, unit tests, and the README updates.

### Dependency Management

- **Pin all dependency versions explicitly**: Do not use `^` or `~` in
  `package.json`.

External dependencies MUST be carefully evaluated before adoption:

- **Prefer vanilla solutions**: Use Node.js built-in APIs and standard
  language features when they adequately solve the problem. Only add a
  dependency when it provides significant value over a vanilla
  implementation.
- **Reputable sources only**: Dependencies MUST come from
  well-established, actively maintained projects. Evaluate by: weekly
  downloads (prefer >100k), GitHub stars, recent commit activity, and
  known maintainers.
- **Avoid unpopular libraries**: Do NOT add niche or obscure packages
  with limited community adoption. These pose security risks and may
  become unmaintained.
- **Minimize dependency count**: Each new dependency increases attack
  surface, bundle size, and maintenance burden. Justify every addition.
- **Use the latest stable version**: When adding a new dependency,
  explicitly check the package registry for the latest stable release and
  use it. Do not copy outdated version numbers from memory, training
  data, or existing lock files of other projects.

### Configuration & Documentation

Configuration and documentation MUST stay synchronized with code:

- **Documentation updates required**: Changes to build process or
  configuration MUST update relevant documentation.
- **Structure tracking**: Changes to project structure MUST update the
  Project Structure section in `AGENTS.md`.
- **JSONC config support**: Configuration files support JSONC (comments
  and trailing commas). Use `.jsonc` extension for hand-edited configs.
  CLI management commands write plain `.json` (comments cannot
  round-trip). A `.env` file in cwd is auto-loaded at startup — secrets
  should go there, not in the config file.
- **Every server needs a description**: A downstream server entry
  SHOULD carry a short (1-2 sentences at most) `description` explaining
  what the server is and why the model could need it — the compact
  catalog is the only place the model learns what a server is for. The
  `add` command MUST require it, but config loading MUST accept entries
  without one: hand-edited and older configs keep working, and the
  catalog simply omits the description after the tool count for that
  server.
