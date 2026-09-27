/**
 * Test support for the benchmark configuration builders.
 *
 * Creates a throwaway run directory and a `RunContext` so the adapter
 * tests can assert on the generated config files and child
 * environments without touching a real benchmark image.
 *
 * @internal Exported for tests only; not part of the benchmark runtime.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockServers, buildRouterServer } from './servers.js';
import type { BenchAgent, BenchMode, McpServerSpec, RunContext, RunPaths } from './types.js';

/** A prepared test context plus its cleanup hook. */
export interface TestContext {
  /** The run context handed to an adapter. */
  context: RunContext;
  /** The run directory layout. */
  paths: RunPaths;
  /** Removes the temporary run directory. */
  cleanup: () => Promise<void>;
}

/**
 * Creates a run context backed by a temporary run directory.
 *
 * @param agent - The coding agent.
 * @param mode - The benchmark mode.
 * @param env - The BENCH_* environment values for the run.
 * @param servers - Optional explicit server list.
 * @returns The test context and its cleanup hook.
 */
export async function createTestContext(
  agent: BenchAgent,
  mode: BenchMode,
  env: NodeJS.ProcessEnv,
  servers?: McpServerSpec[],
): Promise<TestContext> {
  const runDir = await mkdtemp(join(tmpdir(), 'bench-config-test-'));
  const paths: RunPaths = {
    repoRoot: '/app',
    runDir,
    workspaceDir: join(runDir, 'workspace'),
    homeDir: join(runDir, 'home'),
    configDir: join(runDir, 'agent-config'),
    routerHomeDir: join(runDir, 'router-home'),
    invocationLog: join(runDir, 'mcp-invocations.ndjson'),
  };
  await mkdir(paths.workspaceDir, { recursive: true });
  await mkdir(paths.homeDir, { recursive: true });
  await mkdir(paths.configDir, { recursive: true });
  const context: RunContext = {
    agent,
    mode,
    runId: 'test-run',
    paths,
    servers: servers ?? (mode === 'direct' ? buildMockServers(paths) : [buildRouterServer(paths)]),
    prompt: 'Build a TODO web application.',
    env,
  };
  return {
    context,
    paths,
    cleanup: async () => {
      await rm(runDir, { recursive: true, force: true });
    },
  };
}
