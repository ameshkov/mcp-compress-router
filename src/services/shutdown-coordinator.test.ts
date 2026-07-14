import { describe, it, expect, vi } from 'vitest';
import { ShutdownCoordinator } from './shutdown-coordinator.js';
import { Logger } from '../utils/index.js';

/** A Logger that discards output so tests stay quiet. */
function silentLogger(): Logger {
  return new Logger('error');
}

describe('ShutdownCoordinator — shutdown()', () => {
  it('runs every registered cleanup hook', async () => {
    const coordinator = new ShutdownCoordinator(silentLogger());
    const a = vi.fn(async () => {});
    const b = vi.fn(() => {});

    coordinator.register(a);
    coordinator.register(b);
    await coordinator.shutdown('test');

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('whenShutdown() resolves only after shutdown completes', async () => {
    const coordinator = new ShutdownCoordinator(silentLogger());
    let cleanedUp = false;
    coordinator.register(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      cleanedUp = true;
    });

    const before = cleanedUp;
    await coordinator.shutdown('test');
    // By the time shutdown() resolves, the hook has finished.
    expect(cleanedUp).toBe(true);
    expect(before).toBe(false);

    // whenShutdown shares the same resolution.
    await expect(coordinator.whenShutdown()).resolves.toBeUndefined();
  });

  it('runs cleanups exactly once even when shutdown is called repeatedly', async () => {
    const coordinator = new ShutdownCoordinator(silentLogger());
    const hook = vi.fn(async () => {});

    coordinator.register(hook);
    const first = coordinator.shutdown('first');
    const second = coordinator.shutdown('second');

    expect(first).toBe(second);
    await first;

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('reports isShuttingDown correctly', async () => {
    const coordinator = new ShutdownCoordinator(silentLogger());
    expect(coordinator.isShuttingDown).toBe(false);

    const promise = coordinator.shutdown('test');
    expect(coordinator.isShuttingDown).toBe(true);

    await promise;
    expect(coordinator.isShuttingDown).toBe(true);
  });
});

describe('ShutdownCoordinator — error handling', () => {
  it('does not reject when a cleanup hook throws', async () => {
    const coordinator = new ShutdownCoordinator(silentLogger());
    coordinator.register(async () => {
      throw new Error('boom');
    });
    coordinator.register(async () => {});

    await expect(coordinator.shutdown('test')).resolves.toBeUndefined();
  });

  it('runs the remaining hooks when one rejects', async () => {
    const coordinator = new ShutdownCoordinator(silentLogger());
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    const surviving = vi.fn(async () => {});

    coordinator.register(failing);
    coordinator.register(surviving);
    await coordinator.shutdown('test');

    expect(failing).toHaveBeenCalledTimes(1);
    expect(surviving).toHaveBeenCalledTimes(1);
  });

  it('handles a cleanup that throws synchronously without crashing', async () => {
    const coordinator = new ShutdownCoordinator(silentLogger());
    coordinator.register(() => {
      throw new Error('sync boom');
    });

    await expect(coordinator.shutdown('test')).resolves.toBeUndefined();
  });
});

describe('ShutdownCoordinator — timeout', () => {
  it('stops waiting for a hook that exceeds the cleanup budget', async () => {
    // Use a short 30ms budget so the test is fast.
    const coordinator = new ShutdownCoordinator(silentLogger(), 30);
    let hookFinished = false;
    coordinator.register(() => {
      // Resolves well after the deadline so the coordinator must give up
      // waiting and resolve shutdown() first.
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          hookFinished = true;
          resolve();
        }, 1000);
      });
    });

    const start = Date.now();
    await coordinator.shutdown('test');
    const elapsed = Date.now() - start;

    // Resolved around the 30ms deadline, nowhere near the 1000ms hook.
    expect(elapsed).toBeLessThan(500);
    expect(hookFinished).toBe(false);
  });
});

describe('ShutdownCoordinator — register after shutdown', () => {
  it('ignores hooks registered after shutdown has started', async () => {
    const coordinator = new ShutdownCoordinator(silentLogger(), 5);
    const first = vi.fn(async () => {});
    const late = vi.fn(async () => {});

    coordinator.register(first);
    const promise = coordinator.shutdown('test');
    // Registering after trigger must be a no-op.
    coordinator.register(late);
    await promise;

    expect(first).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
  });

  it('whenShutdown() alone does not trigger shutdown', async () => {
    const coordinator = new ShutdownCoordinator(silentLogger());
    const hook = vi.fn(async () => {});
    coordinator.register(hook);

    // whenShutdown() must not run the hooks on its own; it only reports
    // completion once shutdown() is actually triggered elsewhere.
    let resolved = false;
    const probe = coordinator.whenShutdown().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(hook).not.toHaveBeenCalled();

    await coordinator.shutdown('test');
    await probe;
    expect(hook).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(true);
  });
});
