---
name: qa-test-planning
description: Use when asked to check QA coverage for a commit, branch, or feature, to update or add Gherkin test cases, or to select which manual test cases to run to validate a change.
---

# QA Test Planning for Changesets

## Overview

Take a code change, work out what the manual Gherkin plans
(`qa/features/`) already cover, close the important gaps, and hand
back a prioritized list of cases for a manual run. This skill covers
only the planning workflow. Every stack detail (fixtures,
preparation, and the commands the plans name) lives in
`qa/README.md`.

## Prerequisites

- The repository contains the manual QA stack: `qa/README.md`,
  `qa/features/`, and `qa/scripts/bdd/`.
- Read `qa/README.md` before planning. It is the source of truth for
  fixtures, setup, and the exact commands and paths the plans use.
  Where this skill and the README disagree, the README wins.
- If `qa/README.md` is missing, STOP: tell the user the manual QA
  stack is not present in this repository and wait. Do not invent a
  stack from memory or from this skill.

## Where things live

- `qa/features/` — the Gherkin plans, one file per area; these define
  what is covered today.
- `qa/scripts/bdd/` — the BDD runner and the `@TC-*` ID check.
- `qa/README.md` — the technical source of truth: the Compose stack,
  fixtures, preparation, commands, and how the plans are executed.

## When this applies

- "Check QA coverage for a commit / branch / feature"
- "Update or add test cases"
- "Select test cases to run to validate this change"
- "What could this change have broken?"

## Scope — when coverage is needed

Plans validate shipped functionality: only behavior a user or
operator can observe. A changeset needs new or updated scenarios only
when it changes such behavior.

Changes to supporting tooling do not need Gherkin coverage:

- test infrastructure itself (QA scripts, runner, Dockerfile, CI)
- fixtures, mock servers, and sample data
- internal refactors with no observable behavior change

Still keep existing plans honest: if a tooling change alters what a
scenario observes (different output, error text, or log lines), update
the affected steps in the same change.

## Step 1 — Understand the changeset

Do not trust the commit message alone; read the actual diff.

```bash
git show --stat <commit>
git show <commit> -- <path>
git log <base>..<branch> --oneline
git diff <base>...<branch> --stat
```

For each touched file, note what behavior it changes and which
consumers it feeds. Pay special attention to edits in shared or
chained code paths — they affect every caller, not just the feature
they were made for. Those are the regression candidates.

## Step 2 — Build the coverage matrix

Map every behavior from the changeset to an existing test case:

- Read the relevant plans in `qa/features/` and the fixtures they
  assume (`qa/README.md` describes those).
- Bullet per behavior: "Behavior — covered by / not covered".
- Verify rather than assume: plans are written after the feature and
  may have drifted.

Common gap classes, in order of likelihood:

- **Combination gaps**: each path is covered alone, but the
  interaction is not. Combine the behaviors the changeset touches and
  look for a case that exercises both.
- **Entry-point gaps**: behavior is covered through one entry point
  but not the others. Only add these when the entry points actually
  differ — when they share an orchestrator, coverage on one surface
  plus the shared path is enough.
- **Stale wording**: a scenario title or step no longer matches the
  behavior it exercises. Fix the wording; do not leave drift.
- **Edge cases**: missing validation and error-handling branches;
  check what the existing plans already cover before adding.

## Step 3 — Add / update scenarios

Write steps in the file's existing style: instructions a human tester
carries out. Name every fixture, path, and command exactly as
`qa/README.md` describes it, so the plan stays executable — never
invent or duplicate stack details in a plan.

- One ID tag per scenario, following the suite's ID convention
  (`@TC-<GROUP>-<case>`; group prefix per file, case number in
  sequence, unique across the suite). It is enforced by
  `pnpm lint:gherkin`.
- Verify observable effects the way the plans already do — output,
  error text, catalog contents, result passthrough. For behavior a
  coding agent can observe, prefer a check in the mock LLM request log
  (`pnpm qa:llm log`): the tool surface, the catalog, the tool-call
  arguments, and the returned result are all visible there.
- Use `Scenario Outline` + `Examples:` for table-driven variants
  (each examples row is executed as a separate case by the runner,
  sharing the ID).
- Before adding a scenario, confirm the behavior is real in the
  implementation, so the manual tester is not asked to verify
  something the system does not do.

## Step 4 — Verify the plans

The ID convention and Gherkin syntax are enforced automatically:

```bash
pnpm lint:gherkin
```

Do not weaken existing scenarios to make a new one fit — keep the
plan honest. If the QA stack itself changed (scripts, fixtures,
commands), update `qa/README.md` in the same change.

## Step 5 — Select cases for the manual run

Return two groups, each a flat list of case IDs with a one-line
rationale per entry:

- **A — new functionality**: every case that exercises the feature
  itself (behavior, validation, error handling, entry-point surface),
  including the newly added combination cases. These must all pass.
- **B — potentially broken**: cases covering shared code paths the
  changeset touched — mainline happy paths of each entry point, error
  and recovery paths, rendering other features also consume, and
  configuration-loading regressions. Pick representative cases; cover
  each changed layer at least once.

Order Phase A first, then Phase B. Return only the selection; running
the cases is covered by the `manual-test-run` skill and
`qa/README.md`.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Planning from the commit message | Read the actual diff; messages can lie |
| Demanding coverage for tooling changes | Only observable behavior needs plans; update steps whose observed output changed |
| Duplicating names or IDs | IDs are suite-unique and enforced by `pnpm lint:gherkin`; scan the suite before adding |
| Writing steps with commands or paths from memory | Take them from `qa/README.md`; the stack is the source of truth |
| Asserting behavior that is not implemented | Verify it first; a plan that cannot pass is a plan bug |
| Selecting the whole suite | Pick per changed layer; Group A must pass, Group B is representative |
| Changing the stack without the README | Update `qa/README.md` in the same change |
