# About development practices

Why this project enforces the gates, test layout, QA stack, and
dependency rules that [AGENTS.md](../../AGENTS.md) states as rules.

## Documentation and static analysis

Every change passes TypeScript compilation, oxlint, Prettier,
Markdownlint, and Knip before merge. The point is not ceremony: the
codebase is small, and the fastest way to keep it navigable is to make
formatting, unused exports, and stale documentation fail loudly in CI
instead of accumulating quietly. Linter and formatter configurations
are treated as fixed — when a rule is inconvenient, the code changes,
not the rule.

## Testing strategy

Unit tests live next to the modules they cover, so a change to a file
and its test happen in the same edit. Integration and end-to-end tests
prefer real components — a fixture MCP server over stdio, the compiled
router as a child process — because transport issues, protocol
mismatches, and serialization errors are exactly the bugs mocks hide.
The E2E suite drives the real binary over MCP JSON-RPC, which is why it
needs a build first.

## Manual QA

The `qa/` stack exists because some behavior can only be judged by
running the router under a real agent: whether the compact catalog is
enough for an LLM to route correctly, and whether shutdown leaves no
processes behind. The mock LLM is a first-class part of that stack — it
validates every request and keeps the raw log — because the log is the
primary evidence that an agent saw the right tool surface and sent the
right arguments. Plans and `qa/README.md` drift silently if they are
not updated with the features they describe, so both are treated as
part of the change.

## Dependencies

Dependencies are pinned exactly, vetted for maintenance and adoption,
and added only when the standard library cannot do the job. Each
dependency is code the project does not control but must ship, so the
bar for adding one is deliberately high.

## Documentation stays synchronized

Build commands, project structure, configuration, and QA instructions
are updated in the same change as the code they describe. Stale
documentation is worse than none: it sends contributors and agents down
paths that no longer exist.
