#!/usr/bin/env node
/**
 * Manual test runner for the Gherkin feature files in `qa/features/`.
 *
 * Walks every Scenario (Scenario Outline rows are expanded), prints the
 * steps, and records the tester's verdict per scenario ID:
 *   p — pass, f — fail, s — skip, q — quit.
 * After the verdict the runner asks for a description of what was done;
 * the description is stored in the report alongside the verdict.
 *
 * Each run gets a unique run ID (a local timestamp by default, or
 * `--run-id`). Verdicts are written progressively to
 * `qa/output/<run-id>/report.json` and `report.md` so an interrupted
 * run keeps the results collected so far. The runner is interactive on
 * a TTY and reads input line-by-line from stdin otherwise.
 *
 * Usage:
 *   pnpm qa:run
 *   pnpm qa:run --list
 *   pnpm qa:run --feature tool-schema
 *   pnpm qa:run --id @TC-SCHEMA-1
 *   pnpm qa:run --auto-pass
 *   pnpm qa:run --run-id <id>
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { generateMessages } from '@cucumber/gherkin';
import { IdGenerator, SourceMediaType } from '@cucumber/messages';

const FEATURES_DIR = fileURLToPath(new URL('../../features/', import.meta.url));
const OUTPUT_DIR = fileURLToPath(new URL('../../output/', import.meta.url));

const { values } = parseArgs({
  options: {
    list: { type: 'boolean', default: false },
    feature: { type: 'string' },
    id: { type: 'string' },
    'auto-pass': { type: 'boolean', default: false },
    'run-id': { type: 'string' },
  },
});

/**
 * Test-ID convention: `@TC-<GROUP>-<case>` with a semantic, uppercase
 * GROUP that names the test area (e.g. `@TC-STARTUP-1`). Shared with
 * `check-gherkin-ids.ts`.
 */
const ID_TAG_PATTERN = /^@TC-[A-Z]+-\d+$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface TestCase {
  id: string;
  scenario: string;
  file: string;
  steps: string[];
}

interface TestResult {
  id: string;
  scenario: string;
  file: string;
  status: 'pass' | 'fail' | 'skip';
  /** Tester's free-text description of what was done/observed. */
  notes: string;
  timestamp: string;
}

interface Report {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  results: TestResult[];
}

/**
 * Builds a unique run ID: a local timestamp (`yyyy-MM-ddTHH-mm-ss`)
 * with a numeric suffix when the directory already exists.
 *
 * @returns A run ID not yet present under `qa/output/`.
 */
function generateRunId(): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const date = new Date();
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  if (!existsSync(join(OUTPUT_DIR, stamp))) {
    return stamp;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stamp}-${suffix}`;
    if (!existsSync(join(OUTPUT_DIR, candidate))) {
      return candidate;
    }
  }
}

const runId = values['run-id'] ?? generateRunId();
if (!RUN_ID_PATTERN.test(runId)) {
  console.error(
    'qa: invalid --run-id, use letters, digits, dots, underscores or ' + `hyphens (got "${runId}")`,
  );
  process.exit(1);
}
const REPORT_DIR = join(OUTPUT_DIR, runId);

/**
 * Parses all feature files into test cases (pickles), filtered by
 * `--feature` / `--id`.
 *
 * @returns The matching test cases in file order.
 */
async function loadTestCases(): Promise<TestCase[]> {
  const files = (await readdir(FEATURES_DIR)).filter((file) => file.endsWith('.feature'));
  const cases: TestCase[] = [];
  for (const file of files) {
    if (values.feature && !file.includes(values.feature)) {
      continue;
    }
    const source = await readFile(join(FEATURES_DIR, file), 'utf8');
    const messages = generateMessages(source, file, SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, {
      includeGherkinDocument: false,
      includePickles: true,
      newId: IdGenerator.uuid(),
    });
    for (const message of messages) {
      const pickle = message.pickle;
      if (!pickle) {
        continue;
      }
      const idTag = (pickle.tags ?? []).find((tag) => ID_TAG_PATTERN.test(tag.name));
      if (!idTag) {
        console.warn(`qa: ${file}: ${pickle.name} has no @TC tag, skipping`);
        continue;
      }
      if (values.id && idTag.name !== values.id) {
        continue;
      }
      cases.push({
        id: idTag.name,
        scenario: pickle.name,
        file,
        steps: pickle.steps.map((step) => step.text),
      });
    }
  }
  return cases;
}

/**
 * Renders the markdown report for the current run.
 *
 * @param report - The report collected so far.
 * @returns The markdown document.
 */
function renderMarkdown(report: Report): string {
  const lines = [
    '# Manual Gherkin test report',
    '',
    `Run ID: ${report.runId}`,
    `Started: ${report.startedAt}`,
    `Finished: ${report.finishedAt ?? 'in progress'}`,
    '',
    '## Summary',
    '',
    '| ID | Status | Scenario | File |',
    '| --- | --- | --- | --- |',
  ];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const result of report.results) {
    if (result.status === 'pass') passed += 1;
    if (result.status === 'fail') failed += 1;
    if (result.status === 'skip') skipped += 1;
    lines.push(`| ${result.id} | ${result.status} | ${result.scenario} | ${result.file} |`);
  }
  lines.push('');
  lines.push(`Summary: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  lines.push('', '## Details', '');
  for (const result of report.results) {
    lines.push(`### ${result.id} — ${result.scenario}`, '');
    lines.push(`Status: ${result.status}`);
    lines.push(`Notes: ${result.notes === '' ? '—' : result.notes}`, '');
  }
  return lines.join('\n') + '\n';
}

/**
 * Writes the current report (JSON + markdown) to the run directory.
 *
 * @param report - The report to persist.
 */
async function writeReport(report: Report): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(join(REPORT_DIR, 'report.md'), renderMarkdown(report), 'utf8');
}

const cases = await loadTestCases();
if (cases.length === 0) {
  console.error('qa: no test cases matched the filters');
  process.exit(1);
}

if (values.list) {
  console.log(`${cases.length} test case(s):\n`);
  for (const testCase of cases) {
    console.log(`${testCase.id.padEnd(16)} ${testCase.scenario}`);
    console.log(`                 ${testCase.file} (${testCase.steps.length} steps)`);
  }
  process.exit(0);
}

const report: Report = {
  runId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  results: [],
};

// Read input line-by-line from stdin. The async iterator buffers input,
// so lines are never lost while the report is being written between
// prompts (a readline 'line' listener would race here).
const input = createInterface({ input: stdin });
const lines = (async function* (): AsyncGenerator<string> {
  for await (const line of input) {
    yield line.trim();
  }
})();
const promptLine = (question: string): Promise<string> =>
  (async () => {
    stdout.write(question);
    const { value, done } = await lines.next();
    return done ? '' : value;
  })();

const statusFromVerdict = (verdict: string): 'pass' | 'fail' | 'skip' =>
  verdict === 'f' ? 'fail' : verdict === 's' ? 'skip' : 'pass';

for (const testCase of cases) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`${testCase.id} — ${testCase.scenario}`);
  console.log(`File: ${testCase.file}`);
  for (const step of testCase.steps) {
    console.log(`  - ${step}`);
  }

  let verdict: string;
  let notes = '';
  if (values['auto-pass']) {
    verdict = 'p';
    console.log('  [auto-pass]');
  } else {
    const answer = await promptLine('\n  [p]ass [f]ail [s]kip [q]uit > ');
    const verdictLine = answer.toLowerCase();
    if (verdictLine === '' || verdictLine === 'q' || verdictLine === 'quit') {
      console.log('  (quit)');
      break;
    }
    verdict = verdictLine === 'f' ? 'f' : verdictLine === 's' ? 's' : 'p';
    notes = await promptLine('  [description] what did you do or observe? (Enter to skip) > ');
  }

  report.results.push({
    id: testCase.id,
    scenario: testCase.scenario,
    file: testCase.file,
    status: statusFromVerdict(verdict),
    notes,
    timestamp: new Date().toISOString(),
  });
  await writeReport(report);
}

report.finishedAt = new Date().toISOString();
await writeReport(report);
input.close();

const passed = report.results.filter((result) => result.status === 'pass').length;
const failed = report.results.filter((result) => result.status === 'fail').length;
const skipped = report.results.filter((result) => result.status === 'skip').length;
console.log(`\n${'='.repeat(72)}`);
console.log(`Run ID: ${report.runId}`);
console.log(`Done: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log(`Report: ${join(REPORT_DIR, 'report.md')}`);
