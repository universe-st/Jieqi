/**
 * Reactive side effects: dependency tracking, scheduler integration, cleanup callbacks,
 * pause/resume, and effect-scope registration.
 */

import type { Dep, Subscriber } from './dep';
import { cleanupDeps, setActiveSub } from './dep';
import type { FlushMode, SchedulerJob } from './scheduler';
import { queueJob } from './scheduler';
import type { EffectScope } from './scope';
import { recordScope } from './scope';
import { RECURSION_LIMIT, recursiveUpdateError, warn } from '../utils/dev';

export type EffectCleanup = () => void;

/** Registers a cleanup callback that runs before the next run and on `stop()`. */
export type OnCleanup = (cleanup: EffectCleanup) => void;

export type EffectFn<T = unknown> = (onCleanup: OnCleanup) => T;

export interface EffectOptions {
  /** Takes over scheduling of this effect's re-runs; receives the runner to invoke later. */
  scheduler?: (run: () => void) => void;
  /** Skips the initial synchronous run. */
  lazy?: boolean;
  /** Queue lane used when no `scheduler` is given. Defaults to `'pre'`. */
  flush?: FlushMode;
  /** Scope to attach to instead of the currently active one. */
  scope?: EffectScope;
}

/** Handle returned by `effect()`; calling it is a shortcut for `stop()`. */
export interface EffectHandle {
  (): void;
  stop(): void;
  pause(): void;
  resume(): void;
  /**
   * Runs the effect immediately, bypassing the scheduler.
   *
   * While the effect is paused this is a no-op and the run is *remembered*: the effect re-runs once on
   * `resume()`, exactly as a dependency change during the pause would.
   */
  run(): void;
  readonly active: boolean;
}

let effectUid = 0;

/**
 * A tracked side effect. Effects collected dependencies while running; a dependency change either
 * runs the effect immediately (`flush: 'sync'`), hands it to a custom `scheduler`, or queues it in
 * the scheduler lane.
 */
export class ReactiveEffect<T = unknown> implements Subscriber, SchedulerJob {
  readonly id: number = ++effectUid;
  active = true;
  deps: Dep[] | undefined;
  queued = false;
  /** `true` while the effect is suspended by `pause()`. */
  paused = false;
  /** When `false`, a write from inside this effect never re-triggers it. */
  allowRecurse = true;
  /** Custom runnable installed by owners such as `watch()`. */
  job: (() => void) | undefined;
  /** Invoked once when the effect stops (used by `watch` to run its final cleanup). */
  onStop: (() => void) | undefined;

  private readonly fn: EffectFn<T>;
  private readonly schedulerFn: ((run: () => void) => void) | undefined;
  private readonly flush: FlushMode;
  private cleanups: EffectCleanup[] = [];
  private nestedRuns = 0;
  private schedulerPending = false;
  private pendingWhilePaused = false;

  constructor(fn: EffectFn<T>, options: EffectOptions = {}) {
    this.fn = fn;
    this.schedulerFn = options.scheduler;
    this.flush = options.flush ?? 'pre';
    recordScope(this, options.scope);
  }

  /** Runs the effect, collecting dependencies afresh. */
  run(): T | undefined {
    if (!this.active) return undefined;
    if (this.paused) {
      this.pendingWhilePaused = true;
      return undefined;
    }
    if (this.nestedRuns >= RECURSION_LIMIT) {
      const error = recursiveUpdateError(`effect #${this.id}`);
      warn(error.message, false);
      throw error;
    }
    this.nestedRuns++;
    // Drop stale dependencies first so conditional branches cannot keep a subscription alive.
    cleanupDeps(this);
    const previous = setActiveSub(this);
    try {
      this.runCleanups();
      return this.fn(this.onCleanup);
    } finally {
      setActiveSub(previous);
      this.nestedRuns--;
    }
  }

  /** Entry point used by the scheduler: prefers the owner-provided job. */
  runJob(): void {
    if (!this.active) return;
    if (this.job !== undefined) this.job();
    else this.run();
  }

  notify(): void {
    if (!this.active) return;
    if (this.paused) {
      this.pendingWhilePaused = true;
      return;
    }
    if (this.schedulerFn !== undefined) {
      if (this.schedulerPending) return;
      this.schedulerPending = true;
      this.schedulerFn(() => {
        this.schedulerPending = false;
        this.runJob();
      });
      return;
    }
    if (this.flush === 'sync') {
      this.runJob();
      return;
    }
    queueJob(this, this.flush);
  }

  /** Suspends the effect: dependency changes are remembered and replayed by `resume()`. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.pendingWhilePaused) {
      this.pendingWhilePaused = false;
      this.notify();
    }
  }

  /** Detaches from every dependency, runs pending cleanups and never notifies again. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.queued = false;
    this.paused = false;
    this.pendingWhilePaused = false;
    this.runCleanups();
    cleanupDeps(this);
    const onStop = this.onStop;
    this.onStop = undefined;
    if (onStop !== undefined) onStop();
  }

  teardown(): void {
    this.stop();
  }

  private readonly onCleanup: OnCleanup = (cleanup) => {
    this.cleanups.push(cleanup);
  };

  private runCleanups(): void {
    const cleanups = this.cleanups;
    if (cleanups.length === 0) return;
    this.cleanups = [];
    for (let i = 0; i < cleanups.length; i++) cleanups[i]!();
  }
}

/**
 * Creates an effect and runs it once unless `lazy` is set.
 *
 * ```ts
 * const handle = effect((onCleanup) => {
 *   onCleanup(() => release());
 *   render(state.value);
 * });
 * ```
 */
export function effect<T = unknown>(fn: EffectFn<T>, options: EffectOptions = {}): EffectHandle {
  const instance = new ReactiveEffect<T>(fn, options);
  if (options.lazy !== true) instance.run();
  return toEffectHandle(instance);
}

/** Wraps an effect instance into the public, callable handle. */
export function toEffectHandle(instance: ReactiveEffect<unknown>): EffectHandle {
  const handle = (() => {
    instance.stop();
  }) as EffectHandle;
  Object.defineProperty(handle, 'active', {
    configurable: true,
    enumerable: false,
    get: () => instance.active,
  });
  handle.stop = () => {
    instance.stop();
  };
  handle.pause = () => {
    instance.pause();
  };
  handle.resume = () => {
    instance.resume();
  };
  handle.run = () => {
    instance.run();
  };
  return handle;
}
