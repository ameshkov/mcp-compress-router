---
name: manual-test-run
description: Use when asked to run manual tests, execute a QA plan or Gherkin scenario, run the recommended test cases for a change, or produce a QA run report.
---

# Running Manual QA Tests

## Overview

Run the project's manual Gherkin plans (`qa/features/`) and record
verdicts with the BDD runner (`qa/scripts/bdd/`). The plans execute
inside the QA Docker workspace built from `qa/Dockerfile`, never from
a host checkout. This skill covers only the BDD workflow — enumerating
cases, executing them, and producing a report. Every stack detail
(fixtures, preparation, and the commands that drive the system under
test) lives in `qa/README.md`.

## Prerequisites

- The repository contains the manual QA stack: `qa/README.md`,
  `qa/features/`, and `qa/scripts/bdd/`.
- Docker is available: the plans run in the QA workspace built from
  `qa/Dockerfile`, not in a host checkout.
- Read `qa/README.md` before executing anything. It is the source of
  truth for fixtures, setup, and the exact commands and paths the
  scenarios name. Where this skill and the README disagree, the README
  wins.
- If `qa/README.md` is missing, STOP: tell the user the manual QA
  stack is not present in this repository and wait. Do not improvise a
  setup or reconstruct commands from this skill.

## Where things live

- `qa/features/` — the Gherkin plans, one file per area. A scenario's
  steps are instructions a tester carries out.
- `qa/scripts/bdd/` — the BDD runner (enumerate, walk, record) and the
  `@TC-*` ID check.
- `qa/README.md` — the technical source of truth: test fixtures
  (configs, mock servers, router homes, host configs), preparation,
  and the commands the plans use.
- `qa/output/<run-id>/` — generated reports (`report.json` and
  `report.md`); gitignored.

## When this applies

- "Run the manual tests for this change"
- "Run the recommended cases" (a list chosen by `qa-test-planning`)
- "Execute `<feature>` / `<case-id>`"
- "Produce a QA run report"

## Step 0 — Prepare the stack

Read `qa/README.md` and carry out its preparation and preflight
exactly as written: build the Compose stack, start it, and open a
shell in the workspace container. This skill deliberately does not
repeat those commands: when the stack changes, the README is updated
with it.

Run every later command in this skill inside the workspace container
(`docker compose -f qa/docker-compose.yml exec workspace <command>`),
not on the host. The mock LLM and the mock MCP servers run as separate
Compose services the README describes.

If preparation fails, STOP and report the failure. Do not start
executing scenarios against a setup the README does not describe.

## Runner quick reference

These commands run inside the QA workspace (`docker compose -f
qa/docker-compose.yml exec workspace <command>`); `qa/README.md` owns
the container lifecycle and the fixture paths.

| Goal | Command |
| --- | --- |
| Enumerate every case | `pnpm qa:run --list` |
| Enumerate one feature file | `pnpm qa:run --feature <name> --list` |
| Enumerate one case | `pnpm qa:run --id @TC-<GROUP>-<n> --list` |
| Walk cases interactively | `pnpm qa:run --feature <name>` or `pnpm qa:run --id @TC-<GROUP>-<n>` |
| Record-only run (not verification) | `pnpm qa:run --auto-pass` |
| Fixed run id | `pnpm qa:run --run-id <id>` |

Selection is by feature filename substring or exact case ID. A
`--feature` selection walks every scenario in that file in file
order, expanding each `Scenario Outline` examples row into one case
(rows share the ID).

## Step 1 — Enumerate the cases

List exactly what will run, in order, before executing anything:

```bash
pnpm qa:run --list
pnpm qa:run --feature <name> --list
```

The `--list` output is authoritative for order, IDs, and step counts.

## Step 2 — Execute each case

For each case, carry out its steps against the prepared stack inside
the QA workspace, using the fixtures and commands exactly as written
in `qa/README.md` and the plan, and observe the result the steps ask
for. For agent-driven cases the mock LLM log (`pnpm qa:llm log`) is
the primary evidence; the agent transcript and the mock MCP container
logs are supporting channels.

Do not record a verdict you have not verified. If a case's steps no
longer match the implementation, record it honestly — fail or skip
with a note explaining the drift. Fixing stale plans belongs to the
`qa-test-planning` skill, not to this workflow.

## Step 3 — Record verdicts

Walk the cases interactively inside the workspace (see the quick
reference). For each case the runner prints its steps, accepts one
verdict line (`p`/`f`/`s`/`q` — pass / fail / skip / quit; anything
else counts as pass), then accepts one free-text description of what
was done or observed, stored with the verdict. `--auto-pass` skips
both prompts and is a record-only mode, not verification.

Record exactly one verdict line and one description line per case the
runner walks, in `--list` order. Never drop a case: an unselected or
unrunnable case gets `s` (skip) with a one-line reason. Misaligned
input is the number one failure mode of a run.

## Step 4 — Verify the report

Reports are written progressively to `qa/output/<run-id>/` inside
the workspace (a named volume, so they survive container recreation).
Copy the report into the checkout (`docker compose -f
qa/docker-compose.yml cp`; see `qa/README.md`) before removing the
stack, then check it:

- The summary counts the right number of cases for the selection; a
  short count usually means the input ended early.
- Per-case statuses and notes align with what you meant to record
  (runner order = file order; spot-check a few IDs, not just the
  summary).
- Every `fail` and `skip` carries a note a human can act on.

## Step 5 — Clean up

Copy the report into the checkout's `qa/output/<run-id>/`, then
stop the Compose stack (`docker compose -f qa/docker-compose.yml
down`) and remove any scratch state the run created outside it
(temporary homes, logs, configs, leftover processes). Leave the
working tree clean except for `qa/output/<run-id>/`. Never delete the
report or the committed fixture set.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Runner input misaligned (extra or missing line) | Enumerate with `--list`, feed one verdict + one description per case, verify counts afterwards |
| Recording a pass without executing the steps | Execute first; when unsure, skip with a reason |
| Running the plans from a host checkout | Run them inside the Compose workspace; plans only run there |
| Running against a stale workspace image | The workspace bakes the repository; rebuild the stack after any source or QA change |
| Losing the report when the stack is removed | Copy `qa/output/<run-id>/` out with `docker compose cp` before cleanup |
| Assuming `--feature` runs one scenario | It walks every scenario in the file; account for all of them, run or skip |
| Treating `--auto-pass` as verification | It only records; use it for record-only runs |
| Passing a stale plan | Fail or skip with a drift note; plan updates belong to `qa-test-planning` |
| Improvising setup from this skill | Read `qa/README.md`; it is the source of truth |
| Leaving scratch state behind | Clean up after the run |
