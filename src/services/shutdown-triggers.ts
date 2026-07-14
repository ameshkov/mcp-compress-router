import process from 'node:process';
import type { ShutdownCoordinator } from './shutdown-coordinator.js';
import type { Logger } from '../utils/index.js';

/**
 * Signals whose arrival should trigger a graceful shutdown. `SIGHUP` is
 * included because some hosts send it when the controlling terminal
 * disappears.
 */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Installs process-global triggers that call
 * {@link ShutdownCoordinator.shutdown} when the router should stop:
 *
 * - `SIGINT` / `SIGTERM` / `SIGHUP` — the host asked us to terminate.
 * - stdin `'end'` / `'close'` — the host closed our input pipe without
 *   sending a signal. This is the most common cause of ghost router
 *   processes that never exit: the MCP SDK's stdio server transport only
 *   listens for `'data'` / `'error'` on stdin, so without this hook the
 *   router lingers forever while spawned downstream servers keep the
 *   event loop alive.
 *
 * A second shutdown signal force-exits immediately so that a stuck
 * cleanup never traps the user with an unresponsive process.
 *
 * @param coordinator - The coordinator to trigger on signal or stdin EOF.
 * @param logger - Structured logger for trigger diagnostics.
 */
export function installShutdownTriggers(coordinator: ShutdownCoordinator, logger: Logger): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      if (coordinator.isShuttingDown) {
        logger.warn('Forcing immediate exit on signal during shutdown', { signal });
        process.exit(1);
      }
      void coordinator.shutdown(`signal:${signal}`);
    });
  }
  watchStdinClose(coordinator);
}

/**
 * Treats stdin EOF as a shutdown trigger. The host (IDE/editor/agent)
 * typically ends the router by closing its stdin pipe without sending a
 * signal; without this watcher the router would linger as a ghost
 * process because the SDK ignores stdin EOF.
 *
 * Listeners are removed after the first trigger so a later `'close'`
 * event (e.g. from the SDK tearing the transport down during cleanup)
 * cannot re-enter the coordinator.
 */
function watchStdinClose(coordinator: ShutdownCoordinator): void {
  const stdin = process.stdin;
  const trigger = (): void => {
    stdin.off('end', trigger);
    stdin.off('close', trigger);
    void coordinator.shutdown('stdin-closed');
  };
  stdin.on('end', trigger);
  stdin.on('close', trigger);
}
