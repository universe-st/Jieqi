/**
 * Development-mode switch, warning channel and the recursion guard helpers shared by effects and
 * the scheduler. Everything here is cheap when no warning is emitted: `devMode` is checked first.
 */

export type DevWarningHandler = (message: string) => void;

/** Number of times a subscriber may re-enter itself before the update is treated as cyclic. */
export const RECURSION_LIMIT = 100;

/** Upper bound of the once-per-message warning cache; see `warn()`. */
const MAX_REPORTED_WARNINGS = 500;

let devMode = true;
const handlers = new Set<DevWarningHandler>();
const reported = new Set<string>();

export const isDevMode = (): boolean => devMode;

/** Enables or disables development warnings (enabled by default). */
export const setDevMode = (enabled: boolean): void => {
  devMode = enabled;
};

/** Registers a warning listener and returns an unsubscribe function. */
export const onDevWarning = (handler: DevWarningHandler): (() => void) => {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
};

/** Forgets the dedupe cache so the same message can be reported again. */
export const resetDevWarnings = (): void => {
  reported.clear();
};

/** Reports a development warning once per message; falls back to `console.warn`. */
export const warn = (message: string, once = true): void => {
  if (!devMode) return;
  const text = `[phaser-mvvm] ${message}`;
  if (once) {
    if (reported.has(text)) return;
    if (reported.size >= MAX_REPORTED_WARNINGS) {
      // The dedupe key holds the interpolated message, and some warnings embed user data (a property
      // key, a path), so the set must not grow without bound in a long-running app.
      reported.clear();
    }
    reported.add(text);
  }
  if (handlers.size > 0) {
    for (const handler of handlers) handler(text);
    return;
  }
  console.warn(text);
};

/**
 * Prints a development-only diagnostic line.
 *
 * Unlike {@link warn} this is not deduplicated: it traces what the framework did on a given frame
 * (scope builds, layout passes, binding runs). Release builds call `setDevMode(false)` and pay a
 * single boolean check, so call sites may stay in the hot path.
 */
export const devLog = (message: string, data?: unknown): void => {
  if (!devMode) return;
  if (data === undefined) {
    console.log(`[phaser-mvvm] ${message}`);
    return;
  }
  console.log(`[phaser-mvvm] ${message}`, data);
};

/** Builds the error thrown when a reactive update keeps re-triggering itself. */
export const recursiveUpdateError = (target: string): Error =>
  new Error(
    `[phaser-mvvm] Maximum recursive updates exceeded (${RECURSION_LIMIT}) while running ${target}. ` +
      'A reactive effect is mutating a dependency it also reads; break the cycle or write to the ' +
      'state from a scheduler task instead.',
  );
