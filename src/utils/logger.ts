/**
 * Log levels in order of increasing verbosity.
 */
type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Structured log entry written to stderr as a single JSON line.
 */
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  /** Optional key-value metadata. */
  context?: Record<string, unknown>;
}

/**
 * A lightweight structured logger that writes timestamped JSON lines
 * to stderr with configurable level filtering.
 */
export class Logger {
  private currentLevel: LogLevel;

  /**
   * Creates a Logger at the given level. Messages below this level
   * are silently dropped.
   *
   * @param level - Minimum log level to emit.
   */
  constructor(level: LogLevel = 'info') {
    this.currentLevel = level;
  }

  /**
   * Returns true if messages at the given level would be emitted.
   *
   * @param level - The level to check.
   */
  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this.currentLevel];
  }

  /**
   * Changes the minimum log level at runtime.
   *
   * @param level - New minimum log level.
   */
  setLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  /**
   * Emits an error-level log entry.
   *
   * @param message - Human-readable error message.
   * @param context - Optional key-value metadata (server name, error details).
   */
  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  }

  /**
   * Emits a warn-level log entry. Suppressed when level is 'error'.
   * Used for degraded-mode conditions and recoverable runtime failures.
   *
   * @param message - Human-readable warning message.
   * @param context - Optional key-value metadata.
   */
  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  /**
   * Emits an info-level log entry. Suppressed when level is 'error' or
   * 'warn'.
   *
   * @param message - Human-readable info message.
   * @param context - Optional key-value metadata.
   */
  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  /**
   * Emits a debug-level log entry. Suppressed unless level is 'debug'.
   *
   * @param message - Human-readable debug message.
   * @param context - Optional key-value metadata (payloads, state).
   */
  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    if (context !== undefined && Object.keys(context).length > 0) {
      entry.context = context;
    }
    process.stderr.write(JSON.stringify(entry) + '\n');
  }
}
