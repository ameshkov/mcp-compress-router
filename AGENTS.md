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
    - [Dependency Management](#dependency-management)
    - [Configuration & Documentation](#configuration--documentation)
    - [Markdown Formatting](#markdown-formatting)

## Project Overview

A single MCP (Model Context Protocol) server that acts as a router. Instead
of sending all tool names and descriptions from every connected MCP to the
LLM on every request, this server exposes only two tools:

- **`get_tool_schema`** — returns the JSON parameter schema for one or more
  tools on a connected MCP server.
- **`invoke_tool`** — forwards a tool invocation to a connected MCP server
  and returns the result.

The LLM first calls `get_tool_schema` to learn the parameters, then calls
`invoke_tool` to execute. This reduces token overhead by ~96% for a typical
coding session with 3 MCP servers.

## Technical Context

| Field | Value |
| --- | --- |
| Language | TypeScript 5.9, ES2022 target, strict mode |
| Runtime | Node.js 22+ |
| Package Manager | pnpm 10+ |
| Framework | MCP SDK (`@modelcontextprotocol/sdk`) |
| Linting | ESLint 9.x + typescript-eslint |
| Formatting | Prettier 3.x, Markdownlint (markdownlint-cli2) |
| Project Type | MCP server (stdio transport) |

## Project Structure

```text
mcp-compress-router/
├── src/                      # Application source code
│   ├── index.ts              # MCP server entry point (stdio transport) + CLI dispatch
│   ├── cli/                   # Management CLI subcommands
│   │   ├── index.ts           # Barrel exports (public API)
│   │   ├── config-io.ts       # Raw mcp.json read/write with first-use creation
│   │   ├── config-io.test.ts  # Unit tests for config I/O
│   │   ├── add-command.ts     # add subcommand handler
│   │   ├── add-command.test.ts # Unit tests for add command
│   │   ├── remove-command.ts  # remove subcommand handler
│   │   ├── remove-command.test.ts # Unit tests for remove command
│   │   ├── get-command.ts     # get subcommand handler
│   │   ├── get-command.test.ts # Unit tests for get command
│   │   ├── list-command.ts    # list subcommand handler
│   │   └── list-command.test.ts # Unit tests for list command
│   ├── services/             # Core business logic
│   │   ├── index.ts           # Barrel exports (public API)
│   │   ├── config.ts          # Configuration loader
│   │   ├── discovery.ts       # Downstream Connection Manager
│   │   ├── catalog.ts         # Catalog Builder & Cache
│   │   ├── config.test.ts     # Unit tests for config loading
│   │   ├── discovery.test.ts  # Integration tests for downstream discovery
│   │   ├── catalog.test.ts    # Unit tests for catalog and schema lookup
│   │   ├── invoker.ts         # Downstream tool invocation
│   │   └── invoker.test.ts    # Unit tests for tool invocation
│   ├── utils/                 # Shared utilities
│   │   ├── index.ts           # Barrel exports (public API)
│   │   ├── expand-env.ts      # ${VAR} / ${VAR:-default} expansion
│   │   ├── expand-env.test.ts # Unit tests for env var expansion
│   │   ├── parse-jsonc.ts     # JSONC parser wrapper (comments + trailing
│   │   │                        commas)
│   │   ├── parse-jsonc.test.ts # Unit tests for parseJsonc
│   │   ├── text-format.ts     # Compact catalog text renderer
│   │   ├── types.ts           # Shared type definitions
│   │   ├── validate-arguments.ts   # JSON Schema argument validation
│   │   ├── validate-arguments.test.ts
│   │   ├── open-browser.ts    # Platform-safe browser opener using spawn()
│   │   └── open-browser.test.ts # Unit tests for browser opener
│   └── tools/                 # Router tool handlers
│       ├── index.ts           # Barrel exports (public API)
│       ├── get-tool-schema.ts
│       └── invoke-tool.ts
├── test/                     # Shared test infrastructure
│   ├── fixture-server.ts     # Reusable fixture stdio downstream MCP server
│   ├── fixture-http-server.ts # Reusable fixture HTTP downstream MCP server
│   └── e2e/                  # End-to-end tests
│       ├── helpers.ts         # Shared E2E utilities (fixture paths, spawn)
│       ├── client.ts          # JSON-RPC test client over stdio
│       ├── cli.test.ts        # E2E tests for management CLI subcommands
│       ├── fail-fast.test.ts  # Fail-fast startup behavior tests
│       ├── stdio.test.ts      # E2E tests with stdio downstream server
│       ├── http.test.ts       # E2E tests with HTTP downstream server
│       └── mixed.test.ts      # E2E tests with stdio + HTTP together
├── docs/                     # Documentation and assets
│   ├── getting-started.md    # Quick-start and installation guide
│   ├── configuration.md      # Full configuration & env var reference
│   └── assets/               # Example JSON payloads
├── DEVELOPMENT.md            # Local setup & manual testing guide
├── .env                      # Local environment (gitignored)
├── .env.example              # Environment variable template (committed)
├── eslint.config.mjs         # ESLint flat config
├── knip.config.ts            # Knip unused-export analysis config
├── mcp.example.jsonc         # Example JSONC config template (committed)
├── tsconfig.json             # TypeScript configuration (production)
├── tsconfig.test.json        # TypeScript configuration (tests, noEmit)
├── vitest.config.ts          # Vitest configuration
└── package.json              # Project dependencies and scripts
```

## Build and Test Commands

- `pnpm build` — compile TypeScript to `build/` and make executable
- `pnpm typecheck` — check for TypeScript type errors in production
  and test code
- `pnpm lint` — lint source files with ESLint and check for unused
  exports with Knip
- `pnpm lint:fix` — lint and auto-fix issues
- `pnpm knip` — run Knip unused-export analysis separately
- `pnpm format:check` — check formatting with Prettier and Markdownlint
- `pnpm format:fix` — fix formatting issues
- `pnpm check` — run `format:check`, `lint`, and `typecheck` (full CI gate)
- `pnpm clean` — remove `node_modules` and `build/`

## Contribution Instructions

You MUST follow the following rules for EVERY task that you perform:

- You MUST verify it with linter, formatter, and TypeScript compiler.

  Use the following commands:
    - `pnpm typecheck` to check for TypeScript type errors
    - `pnpm lint` to run the linter (ESLint) and Knip unused-export
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

## Code Guidelines

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
- **Keep It Boring** — prefer well-understood patterns over clever or
  novel solutions.

The easiest way to achieve these principles is **layered architecture**.
This project's layers, from top to bottom:

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
configuration objects. These are implementation details wired inside the
entry point.

### Code Quality

All code MUST meet documentation and style requirements before merge:

- **Public API documentation**: Exported functions, classes, interfaces,
  and their properties MUST have JSDoc comments describing purpose,
  arguments, return values, and thrown errors (use `@throws` only for
  specific errors).
- **Static analysis gates**: Every change MUST pass TypeScript compilation
  (`pnpm typecheck`), ESLint (`pnpm lint`), and Prettier/Markdownlint
  (`pnpm format:check`) before merge.
- **Do not modify linter or formatter configurations**: Never change
  ESLint, Prettier, Markdownlint, or TypeScript configuration files
  (`eslint.config.mjs`, `.prettierrc`, `.prettierignore`,
  `.markdownlint-cli2.yaml`, `tsconfig.json`) to work around lint or
  formatting errors. Fix the source code instead. If the issue cannot be
  resolved after a few attempts, ask the human for help.
- **Error handling strategy**: Prefer throwing errors over returning error
  values. Handle errors at top-level entry points where they can be logged.
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
- **File size limit**: Source files SHOULD stay within 300 lines of code.
  When a file approaches or exceeds this limit — or fails the ESLint
  `max-lines` gate (500 lines) — your FIRST and default response MUST be
  to **split the file into several smaller, cohesive files**, each with a
  single, clear responsibility (extract related functions, types, or
  constants into dedicated modules, utilities, or services, and
  re-export them through the barrel). Treat the limit as a signal that
  the file is doing too much, not as a quota to optimize against. You
  MUST attempt a split before any other tactic; only fall back if you can
  articulate a concrete reason a split would hurt clarity. For test
  files, split a large `*.test.ts` into multiple focused `*.test.ts`
  files grouped by the behavior they verify — multiple test files per
  source module are explicitly allowed. **Do NOT** satisfy the limit by
  making the existing code shorter: no condensing tests into table-driven
  blocks purely to save lines, no shortening of identifiers, string
  literals, or file paths, no merging statements onto one line, and no
  removing blank lines, comments, or JSDoc. Formatting is managed by
  Prettier and must stay uniform — readability and clarity always win
  over line count.
  Exceptions: auto-generated files and database migration files.
- **Function size limit**: Functions SHOULD stay within 50 lines of code.
  When approaching or exceeding this limit, break the function into
  smaller, named helper functions with single, clear responsibilities.
  **Do NOT** condense logic into dense one-liners, inline multiple
  statements on a single line, or strip whitespace to fit the limit —
  formatting is managed by Prettier and must not be sacrificed for
  brevity.
  Exceptions: auto-generated files and database migration files.

**Rationale**: Consistent documentation and tooling enforcement prevents
technical debt accumulation and ensures codebase navigability.

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

**Rationale**: Co-locating tests with source keeps related files close,
making it easier to find, update, and maintain tests. Testing against
real components catches bugs that mocks hide (transport issues, protocol
mismatches, serialization errors) and gives higher confidence in the
system's actual behavior.

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

**Rationale**: Fewer, well-vetted dependencies reduce security
vulnerabilities, supply chain risks, and long-term maintenance costs.

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

**Rationale**: Stale documentation causes onboarding friction and
operational incidents.

### Markdown Formatting

All Markdown files MUST follow these formatting rules:

- **Line length**: Keep lines at most 80 characters. This is not a hard
  lint gate, but SHOULD be followed for readability. Lines inside fenced
  code blocks are exempt from this limit.
- **Unordered lists**: Use dashes (`-`) for bullet points. Indent nested
  list items by 4 spaces.
- **Emphasis**: Use asterisks (`*`) for emphasis (`*italic*`,
  `**bold**`). Do NOT use underscores.
- **Headings**: Duplicate heading names are allowed only among sibling
  headings (same parent level). Avoid duplicates across different levels.
- **Inline HTML**: Avoid raw HTML in Markdown. The only allowed elements
  are `<a>`, `<p>`, `<details>`, `<summary>`, and `<img>`.
- **Trailing spaces**: Do NOT leave trailing whitespace on any line. Do
  NOT use two-space line breaks — use a blank line instead.
- **Bare URLs**: Bare URLs are permitted and do not need to be wrapped
  in angle brackets.
- **Table formatting**: Align table columns with padding when the table
  fits within 80 characters. If the table exceeds 80 characters or
  triggers an MD060 linter warning, switch to a compact format using
  single spaces only. This applies to the separator row as well — it
  should be written as `| --- |`, not `|--|`.

  Example of correct layout:

  ```markdown
  | Col1 | Col2 |
  | --- | --- |
  | Value1 | Value2 |
  ```

  Do NOT use extra padding or alignment characters beyond single spaces.

**Rationale**: Uniform Markdown formatting improves readability for both
humans and AI agents that consume project documentation.
