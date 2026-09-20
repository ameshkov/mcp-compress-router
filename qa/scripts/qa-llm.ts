#!/usr/bin/env node
/**
 * Control and inspection tool for the QA mock LLM.
 *
 * Talks to the mock LLM container's admin API (see
 * `qa/scripts/mock-llm/server.ts`), which is where the manual tests
 * verify what the coding agent sent to the model:
 *
 *   pnpm qa:llm list                  built-in scripts
 *   pnpm qa:llm script <name>         select a script and reset the log
 *   pnpm qa:llm custom <file.json>    install an inline script
 *   pnpm qa:llm status                current script and request count
 *   pnpm qa:llm log                   readable request/response summary
 *   pnpm qa:llm log --raw             complete raw log as JSON
 *   pnpm qa:llm reset                 reset the step and clear the log
 *
 * The mock URL comes from `QA_LLM_URL` (set by the compose stack to
 * `http://mock-llm:8080`). `pnpm qa:llm log` exits 1 when any
 * validation check failed.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  countFailedChecks,
  fetchLog,
  fetchScripts,
  fetchStatus,
  installInlineScript,
  renderLogSummary,
  renderRawLog,
  resetLlm,
  selectScript,
  type InlineScript,
} from './mock-llm/client.js';

/**
 * Prints the available commands.
 */
function printUsage(): void {
  console.error(
    [
      'Usage: pnpm qa:llm <command>',
      '',
      '  list                 list built-in scripts',
      '  script <name>        select a built-in script and reset the log',
      '  custom <file.json>   install an inline script from a JSON file',
      '  status               show the current script and request count',
      '  log [--raw]          show the request/response log',
      '  reset                reset the script step and clear the log',
    ].join('\n'),
  );
}

/**
 * Lists the built-in scripts.
 *
 * @returns Process exit code.
 */
async function listCommand(): Promise<number> {
  const scripts = await fetchScripts();
  for (const script of scripts) {
    console.log(`${script.name} (${script.steps} step(s))`);
    console.log(`  ${script.description}`);
  }
  return 0;
}

/**
 * Selects a built-in script.
 *
 * @param name - The script name.
 * @returns Process exit code.
 */
async function scriptCommand(name: string | undefined): Promise<number> {
  if (name === undefined) {
    console.error('Missing script name. Run "pnpm qa:llm list" to see the built-ins.');
    return 2;
  }
  const result = await selectScript(name);
  console.log(`Selected script "${result.script.name}" (${result.script.steps} step(s)).`);
  console.log('The mock log was cleared; run the coding agent now.');
  return 0;
}

/**
 * Installs an inline script from a JSON file.
 *
 * @param path - The JSON file path.
 * @returns Process exit code.
 */
async function customCommand(path: string | undefined): Promise<number> {
  if (path === undefined) {
    console.error('Missing script file. Pass a JSON file with {"steps": [...]}.');
    return 2;
  }
  const script = JSON.parse(await readFile(path, 'utf8')) as InlineScript;
  const result = await installInlineScript(script);
  console.log(`Installed inline script "${result.script.name}" (${result.script.steps} step(s)).`);
  return 0;
}

/**
 * Shows the current mock state.
 *
 * @returns Process exit code.
 */
async function statusCommand(): Promise<number> {
  const status = await fetchStatus();
  console.log(`Script: ${status.script ?? '(none selected)'}`);
  console.log(`Step: ${status.stepIndex}/${status.steps}`);
  console.log(`Requests: ${status.requestCount}`);
  return 0;
}

/**
 * Shows the request/response log.
 *
 * @param raw - True to print the complete JSON log.
 * @returns Process exit code.
 */
async function logCommand(raw: boolean): Promise<number> {
  const log = await fetchLog();
  console.log(raw ? renderRawLog(log) : renderLogSummary(log));
  const failed = countFailedChecks(log);
  if (failed > 0) {
    console.error(`\n${failed} validation check(s) failed.`);
    return 1;
  }
  return 0;
}

/**
 * Resets the mock step and clears its log.
 *
 * @returns Process exit code.
 */
async function resetCommand(): Promise<number> {
  await resetLlm();
  console.log('Mock LLM reset (step 0, log cleared).');
  return 0;
}

/**
 * Runs the selected command.
 *
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { raw: { type: 'boolean', default: false } },
  });
  switch (positionals[0]) {
    case 'list':
      return listCommand();
    case 'script':
      return scriptCommand(positionals[1]);
    case 'custom':
      return customCommand(positionals[1]);
    case 'status':
      return statusCommand();
    case 'log':
      return logCommand(values.raw);
    case 'reset':
      return resetCommand();
    default:
      printUsage();
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
