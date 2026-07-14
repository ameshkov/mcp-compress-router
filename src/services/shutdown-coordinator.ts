import type { Logger } from '../utils/index.js';

/**
 * Best-effort cleanup hook run exactly once when the router shuts down.
 * Used to close downstream server connections and the MCP server so that
 * spawned child processes are terminated (via the SDK's graduated kill)
 * rather than left orphaned.
 *
 * A hook MUST NOT rethrow — errors are caught and logged by the
 * coordinator so one failing hook can never block the others or delay
 * the final process exit.
 */
export type AsyncCleanup = () => Promise<void> | void;

/** Default overall budget for running every registered cleanup hook. */
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Coordinates graceful shutdown of the router. Downstream resources
 * (server connections, the MCP server) register async cleanup hooks; a
 * single trigger — a process signal or the disappearance of stdin — runs
 * every hook once (each racing a shared timeout) and resolves the awaited
 * {@link ShutdownCoordinator.whenShutdown} promise so the entry point can
 * force-exit.
 *
 * This is the fix for ghost router processes that linger forever: without
 * it, the spawned downstream servers (and their own child processes, e.g.
 * browser processes forked by a downstream server) keep the Node event
 * loop alive even after the host closes the router's stdin pipe, so the
 * router never exits on its own.
 */
export class ShutdownCoordinator {
  private readonly cleanups: AsyncCleanup[] = [];
  private resolveShutdown!: () => void;
  private readonly shutdownPromise = new Promise<void>((resolve) => {
    this.resolveShutdown = resolve;
  });
  private triggered = false;

  /**
   * @param logger - Structured logger for shutdown diagnostics.
   * @param cleanupTimeoutMs - Overall budget for running every hook
   *   before the coordinator stops waiting and lets the process exit.
   *   Defaults to 5 seconds; overridable (mainly for tests).
   */
  constructor(
    private readonly logger: Logger,
    private readonly cleanupTimeoutMs: number = DEFAULT_CLEANUP_TIMEOUT_MS,
  ) {}

  /**
   * Whether shutdown has already been triggered. A `true` value means
   * cleanup hooks are running (or have run); newly registered hooks are
   * ignored from this point on.
   */
  get isShuttingDown(): boolean {
    return this.triggered;
  }

  /**
   * Registers a cleanup hook. Hooks added after shutdown has already
   * started are ignored — the process is already tearing down.
   *
   * @param cleanup - Async function run once during shutdown.
   */
  register(cleanup: AsyncCleanup): void {
    if (this.triggered) {
      return;
    }
    this.cleanups.push(cleanup);
  }

  /**
   * Triggers shutdown: runs every registered hook (each racing the shared
   * cleanup timeout), never rejecting. Safe to call repeatedly — only the
   * first call runs the hooks; later calls return the same promise.
   *
   * @param reason - Why shutdown was triggered (e.g. `signal:SIGTERM`,
   *   `stdin-closed`).
   * @returns Resolves when all hooks finish or time out.
   */
  shutdown(reason: string): Promise<void> {
    if (this.triggered) {
      return this.shutdownPromise;
    }
    this.triggered = true;
    this.logger.info('Shutdown triggered', { reason });
    void this.runCleanups(reason).finally(() => this.resolveShutdown());
    return this.shutdownPromise;
  }

  /**
   * Resolves once shutdown has completed. The router's main loop awaits
   * this so the process stays alive while serving and exits the moment
   * cleanup finishes. Does NOT trigger shutdown on its own.
   */
  whenShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  /**
   * Runs every hook in parallel. A slow or throwing hook never blocks the
   * others or the final exit: each is raced against the shared deadline,
   * and rejections are logged and swallowed.
   */
  private async runCleanups(reason: string): Promise<void> {
    const deadline = this.createDeadline();
    await Promise.all(
      this.cleanups.map((cleanup, index) => this.runOne(cleanup, index, reason, deadline)),
    );
    this.logger.info('Shutdown complete', { reason });
  }

  /**
   * Runs a single hook against the shared deadline. Defers invocation so
   * a synchronous throw becomes a rejection we can race and swallow
   * rather than an uncaught exception.
   */
  private async runOne(
    cleanup: AsyncCleanup,
    index: number,
    reason: string,
    deadline: Promise<void>,
  ): Promise<void> {
    const pending = Promise.resolve().then(() => cleanup());
    // Swallow late rejections so a hook that fails after the deadline
    // already resolved never surfaces an unhandled-rejection warning.
    void pending.catch(() => {});
    try {
      await Promise.race([pending, deadline]);
    } catch (err) {
      this.logger.warn('Cleanup hook failed during shutdown', {
        reason,
        hook: index,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Creates an unref'd timer that resolves after the cleanup budget. */
  private createDeadline(): Promise<void> {
    return new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, this.cleanupTimeoutMs);
      handle.unref?.();
    });
  }
}
