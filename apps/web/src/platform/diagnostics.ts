/**
 * Startup diagnostics.
 *
 * Two rules govern everything in this file:
 *
 * 1. **No secret ever reaches a log.** Encryption passphrases, device secrets, session tokens and
 *    patient/business data must not be printed, not even truncated. Messages are scrubbed before
 *    they are written, because a plugin error can echo a statement, a value or a passphrase-shape
 *    string back to JavaScript. Only shapes are logged, never the material itself.
 * 2. **A failure must be identifiable.** A shop owner reporting "it says the database failed" is not
 *    actionable. Every failure carries a small, stable code (for example
 *    `database:keystore-key-unusable`) that is shown on the failure screen and written to logcat, so
 *    the cause can be named without asking anyone to hand over their data or their key.
 *
 * Native platforms forward `console` output to logcat (Capacitor's BridgeWebChromeClient), which is
 * how these lines become visible in `adb logcat` for support.
 */

const PREFIX = '[MediMart]';

/** Where in initialization a failure happened. */
export type StartupStage = 'browser' | 'secure-storage' | 'database' | 'identity' | 'unknown';

export type StartupFailureInfo = {
  stage: StartupStage;
  /** Stable machine code, e.g. `database:encryption-secret-missing`. */
  code: string;
  /** Short, redacted, human-readable cause. Never contains key material. */
  detail: string;
};

/**
 * Error thrown by the platform layer. Carries the stage and the classified cause so the UI and
 * logcat can name the problem, while `cause` keeps the original error for a stack trace.
 */
export class StartupError extends Error {
  readonly stage: StartupStage;
  readonly code: string;

  constructor(stage: StartupStage, code: string, message: string, options?: { cause?: unknown }) {
    super(`${stage}: ${code} — ${message}`, options);
    this.name = 'StartupError';
    this.stage = stage;
    this.code = code;
  }
}

/**
 * Patterns that must never be logged. Ordered from most specific to most general. The generic
 * long-hex/Base64 rule also covers generated 256-bit secrets, which are 64 hex characters.
 */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  // "passphrase=...", "secret: ...", "token=..." style assignments.
  [/("?(?:passphrase|password|secret|newsecret|token|authorization|api[_-]?key)"?\s*[:=]\s*)("?)[^"',;\s}]+/gi, '$1$2[redacted]'],
  // Long hexadecimal runs (generated 256-bit secrets and fingerprints).
  [/\b[0-9a-f]{32,}\b/gi, '[redacted-hex]'],
  // Long Base64/Base64URL runs (Keystore-wrapped material, JWT segments).
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted-b64]'],
  // Bearer tokens and cookies.
  [/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]'],
];

/** Remove secret-shaped material from a string before it is logged or displayed. */
export function redact(value: string): string {
  let text = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

/** Collapse whitespace, redact, and bound the length so a plugin dump cannot flood logcat. */
export function describeError(error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();
  const collapsed = redact(raw).replace(/\s+/g, ' ').trim();
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed;
}

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, component: string, message: string, detail?: unknown) {
  const line = `${PREFIX} [${component}] ${message}`;
  const args = detail === undefined ? [line] : [line, redact(JSON.stringify(detail) ?? '')];
  // console.* is forwarded to logcat on Android; it is also the only channel available in a
  // WebView, where there is no direct native logger.
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);
}

/** Structured startup logging. Call sites pass no user data and no keys. */
export const startupLog = {
  info: (component: string, message: string, detail?: Record<string, unknown>) =>
    emit('info', component, message, detail),
  warn: (component: string, message: string, detail?: Record<string, unknown>) =>
    emit('warn', component, message, detail),
  error: (component: string, message: string, detail?: Record<string, unknown>) =>
    emit('error', component, message, detail),
};

/**
 * Classify an error message into a stable code.
 *
 * The strings are the ones actually thrown by `@capacitor-community/sqlite` 8.1.1 and by the
 * Android platform around it (Tink / EncryptedSharedPreferences / Android Keystore). Matching text
 * is unavoidable there: the plugin does not expose error codes of its own, and the messages are the
 * documented output of those libraries.
 */
export function classifyDatabaseError(error: unknown): string {
  const message = describeError(error).toLowerCase();
  const has = (...needles: string[]) => needles.some((needle) => message.includes(needle));

  if (has('not implemented') || has('unimplemented')) return 'plugin-capability-missing';
  if (has('no encryption set in capacitor.config')) return 'plugin-encryption-disabled';
  if (has('no passphrase stored')) return 'encryption-secret-missing';
  if (has('already been set')) return 'encryption-secret-already-set';
  if (has('the master key') && has('unusable')) return 'keystore-key-unusable';
  if (has('invalidprotocolbufferexception') || has('invalid tag')) return 'keystore-prefs-corrupt';
  if (has('failed to obtain information about key') || has('unrecoverablekeyexception')) {
    return 'keystore-key-unreadable';
  }
  if (has('keystore operation failed') || has('keyStore'.toLowerCase() + 'exception')) {
    return 'keystore-operation-failed';
  }
  if (has('file is not a database') || has('file is encrypted') || has('not a database')) {
    return 'database-key-mismatch';
  }
  if (has('database is locked')) return 'database-locked';
  if (has('capacitorsqliteplugin:')) return 'plugin-load-failed';
  if (has('no available connection') || has('not opened')) return 'connection-not-open';
  if (has('foreign-key enforcement is unavailable')) return 'foreign-keys-unavailable';
  if (has('connection') && has('already exists')) return 'connection-already-exists';
  if (has('database is closed')) return 'database-closed';
  if (has('disk') && (has('full') || has('i/o error') || has('no space'))) return 'storage-full';
  return 'unclassified';
}

/** Build the value shown on the failure screen and written to logcat. */
export function describeStartupFailure(error: unknown): StartupFailureInfo {
  if (error instanceof StartupError) {
    return { stage: error.stage, code: `${error.stage}:${error.code}`, detail: describeError(error) };
  }
  return {
    stage: 'unknown',
    code: `unknown:${classifyDatabaseError(error)}`,
    detail: describeError(error),
  };
}
