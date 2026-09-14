/**
 * Batched, lane-aware scheduler.
 *
 * Three lanes exist:
 * - `pre` / `post` are merged into a single flush (a microtask by default, `flushSync()` in tests).
 * - `frame` only runs when the render layer calls `flushFrame()` at its per-frame sync point.
 *
 * A host (the Phaser adapter) can take over the `pre`/`post` lanes with `configureScheduler()` so
 * refreshes line up with the game loop instead of the microtask queue. Jobs queued while a flush
 * runs are appended to the current lane and execute after it drains — never re-entrantly nested.
 */

import type { Subscriber } from './dep';
import { RECURSION_LIMIT, recursiveUpdateError, warn } from '../utils/dev';

export type FlushMode = 'sync' | 'pre' | 'post' | 'frame';

/** A schedulable unit of work; `ReactiveEffect` implements this interface. */
export interface SchedulerJob extends Subscriber {
  readonly id: number;
  /** `true` while the job sits in one of the queues; used for once-per-batch dedupe. */
  queued: boolean;
  /** Runs the queued work (the effect body, or a watcher job). */
  runJob(): void;
}

export interface SchedulerHooks {
  /** Takes over `pre` scheduling; the host must call `flush()` when it wants the lane to run. */
  schedulePreFlush?: (flush: () => void) => void;
  /** Takes over `post` scheduling; when omitted, `post` jobs drain at the end of the `pre` flush. */
  schedulePostFlush?: (flush: () => void) => void;
}

const preQueue: SchedulerJob[] = [];
const postQueue: SchedulerJob[] = [];
const frameQueue: SchedulerJob[] = [];
/** Re-entrancy counters for the current flush cycle, so a runaway cascade is reported loudly. */
const runCounts = new Map<SchedulerJob, number>();

let hooks: SchedulerHooks = {};
let flushDepth = 0;
let preFlushScheduled = false;
let postFlushScheduled = false;
let waiters: Array<() => void> | undefined;

/** Replaces the host scheduling hooks; pass nothing to restore the default microtask behaviour. */
export function configureScheduler(next: SchedulerHooks = {}): void {
  hooks = { ...next };
}

/** Returns the currently installed hooks (useful to restore or wrap them). */
export function getSchedulerHooks(): SchedulerHooks {
  return hooks;
}

export const hasPendingJobs = (): boolean => preQueue.length > 0 || postQueue.length > 0;

export const hasPendingFrameJobs = (): boolean => frameQueue.length > 0;

/** Queues a job in the lane of the given flush mode; queuing twice per batch is a no-op. */
export function queueJob(job: SchedulerJob, flush: FlushMode): void {
  if (job.queued) return;
  job.queued = true;
  if (flush === 'frame') {
    frameQueue.push(job);
    return;
  }
  if (flush === 'post') {
    postQueue.push(job);
    ensurePostFlush();
    return;
  }
  preQueue.push(job);
  ensurePreFlush();
}

function ensurePreFlush(): void {
  if (preFlushScheduled) return;
  preFlushScheduled = true;
  if (hooks.schedulePreFlush !== undefined) hooks.schedulePreFlush(flushPreJobs);
  else queueMicrotask(flushPreJobs);
}

function ensurePostFlush(): void {
  if (postFlushScheduled) return;
  postFlushScheduled = true;
  if (hooks.schedulePostFlush !== undefined) {
    hooks.schedulePostFlush(flushPostJobs);
    return;
  }
  // Without a host hook the post lane drains at the tail of the pre flush.
  ensurePreFlush();
}

function flushPreJobs(): void {
  preFlushScheduled = false;
  if (hooks.schedulePostFlush !== undefined) {
    runCycle([preQueue]);
    return;
  }
  postFlushScheduled = false;
  runCycle([preQueue, postQueue]);
}

function flushPostJobs(): void {
  postFlushScheduled = false;
  runCycle([postQueue]);
}

/** Runs every pending `pre` and `post` job synchronously. Frame jobs stay queued. */
export function flushSync(): void {
  if (flushDepth > 0) {
    warn(
      'flushSync() was called while a flush was already running; the jobs join the current flush.',
    );
    return;
  }
  preFlushScheduled = false;
  postFlushScheduled = false;
  runCycle([preQueue, postQueue]);
}

/** Runs every queued `flush: 'frame'` job; the render layer calls this once per frame. */
export function flushFrame(): void {
  runCycle([frameQueue]);
}

/** Resolves once the pending `pre`/`post` jobs and everything they cascade into have flushed. */
export function nextTick(): Promise<void> {
  if (flushDepth === 0 && preQueue.length === 0 && postQueue.length === 0) return Promise.resolve();
  const promise = new Promise<void>((resolve) => {
    (waiters ??= []).push(resolve);
  });
  if (flushDepth === 0) ensurePreFlush();
  return promise;
}

function executeJob(job: SchedulerJob): void {
  const runs = (runCounts.get(job) ?? 0) + 1;
  if (runs > RECURSION_LIMIT) {
    const error = recursiveUpdateError(`scheduled job #${job.id}`);
    warn(error.message, false);
    throw error;
  }
  runCounts.set(job, runs);
  job.runJob();
}

/**
 * Drains one lane. Errors are collected instead of aborting the flush so sibling jobs still run;
 * the first one is re-thrown once the cycle finished.
 */
function runLane(lane: SchedulerJob[], errors: unknown[]): void {
  for (let i = 0; i < lane.length; i++) {
    const job = lane[i]!;
    job.queued = false;
    try {
      executeJob(job);
    } catch (error) {
      errors.push(error);
    }
  }
  lane.length = 0;
}

function runCycle(lanes: SchedulerJob[][]): void {
  const errors: unknown[] = [];
  flushDepth++;
  try {
    for (let i = 0; i < lanes.length; i++) runLane(lanes[i]!, errors);
  } finally {
    flushDepth--;
  }
  finishCycle();
  if (errors.length > 0) throw errors[0];
}

function finishCycle(): void {
  if (preQueue.length > 0) ensurePreFlush();
  if (postQueue.length > 0) ensurePostFlush();
  if (flushDepth > 0 || preQueue.length > 0 || postQueue.length > 0) return;
  runCounts.clear();
  const pending = waiters;
  if (pending === undefined) return;
  waiters = undefined;
  for (let i = 0; i < pending.length; i++) pending[i]!();
}
