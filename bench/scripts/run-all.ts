#!/usr/bin/env tsx
/**
 * Host-side benchmark orchestrator.
 *
 * Builds the benchmark images and runs every agent/mode combination as
 * a separate `docker compose run` (one fresh container per run), then
 * produces the comparison report. Run it from the repository root:
 *
 *   pnpm bench:all
 *   pnpm bench:all -- --agents claude,codex --modes direct
 *
 * The container-side entry point is `bench/scripts/run.ts`; credentials
 * come from `bench/.env` through the compose `env_file`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { scriptArgs } from './args.js';
import { ALL_AGENTS, type BenchAgent, type BenchMode } from './configs/types.js';

/** Compose file, relative to the repository root. */
const COMPOSE_FILE = 'bench/docker-compose.yml';

/** Both benchmark modes. */
const ALL_MODES: BenchMode[] = ['direct', 'router'];

/** Parsed options of one run-all invocation. */
interface RunAllOptions {
  /** Agents to run. */
  agents: readonly BenchAgent[];
  /** Modes to run. */
  modes: BenchMode[];
  /** Optional per-run timeout override in milliseconds. */
  timeout?: string;
  /** Whether ccusage should use cached pricing only. */
  offline: boolean;
  /** Skip building the images. */
  skipBuild: boolean;
  /** Skip the final report. */
  skipReport: boolean;
}

/**
 * Parses a comma-separated list option.
 *
 * @param value - The raw option value.
 * @param allowed - The allowed values.
 * @param label - Option name used in error messages.
 * @returns The selected values, or undefined when the option is absent.
 * @throws Error when a value is not allowed.
 */
function parseList<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string,
): T[] | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parts = value.split(',').map((part) => part.trim());
  for (const part of parts) {
    if (!allowed.includes(part as T)) {
      throw new Error(`Unknown ${label} "${part}" (expected: ${allowed.join(', ')}).`);
    }
  }
  return parts as T[];
}

/**
 * Parses the run-all command line.
 *
 * @returns The validated options.
 */
function parseRunAllOptions(): RunAllOptions {
  const { values } = parseArgs({
    args: scriptArgs(process.argv.slice(2)),
    options: {
      agents: { type: 'string' },
      modes: { type: 'string' },
      timeout: { type: 'string' },
      offline: { type: 'boolean', default: false },
      'skip-build': { type: 'boolean', default: false },
      'skip-report': { type: 'boolean', default: false },
    },
  });
  return {
    agents: parseList(values.agents, ALL_AGENTS, 'agent') ?? ALL_AGENTS,
    modes: parseList(values.modes, ALL_MODES, 'mode') ?? ALL_MODES,
    timeout: values.timeout,
    offline: values.offline,
    skipBuild: values['skip-build'],
    skipReport: values['skip-report'],
  };
}

/**
 * Runs one docker compose command with inherited stdio.
 *
 * @param args - Arguments after `docker compose -f bench/docker-compose.yml`.
 * @returns The process exit code.
 */
function compose(args: string[]): number {
  const result = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    console.error(`Failed to run docker: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Runs every selected agent/mode combination as its own container.
 *
 * @param options - The validated options.
 * @returns Labels of the combinations that reported failure.
 */
function runCombinations(options: RunAllOptions): string[] {
  const failures: string[] = [];
  for (const agent of options.agents) {
    for (const mode of options.modes) {
      const extra = ['--mode', mode];
      if (options.timeout !== undefined) {
        extra.push('--timeout', options.timeout);
      }
      if (options.offline) {
        extra.push('--offline');
      }
      console.log(`\n### ${agent} / ${mode}`);
      if (compose(['run', '--rm', agent, ...extra]) !== 0) {
        failures.push(`${agent}/${mode}`);
      }
    }
  }
  return failures;
}

/**
 * Builds the images and runs the selected combinations.
 */
function main(): void {
  const options = parseRunAllOptions();
  if (!existsSync(COMPOSE_FILE)) {
    throw new Error(`Run this from the repository root (missing ${COMPOSE_FILE}).`);
  }
  if (!existsSync('bench/.env')) {
    throw new Error(
      'Missing bench/.env. Copy bench/.env.example to bench/.env and fill in the credentials.',
    );
  }
  if (!options.skipBuild) {
    console.log('Building benchmark images...\n');
    if (compose(['build']) !== 0) {
      throw new Error('docker compose build failed.');
    }
  }
  const failures = runCombinations(options);
  if (!options.skipReport) {
    console.log('\n### report');
    if (compose(['run', '--rm', 'report']) !== 0) {
      failures.push('report');
    }
  }
  if (failures.length > 0) {
    console.error(`\nFailures: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`bench run-all failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
