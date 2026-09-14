/**
 * Dependency graph core: `Dep` nodes, the active-subscriber stack and the tracking primitives
 * (`untrack`, `pauseTracking`, batched notifications).
 *
 * An effect or computed owns `deps` and is removed from all of them before every re-run, which is
 * what keeps conditional branches from leaving stale subscriptions behind.
 */

/** Anything able to subscribe to a `Dep`: an effect, a watcher job or a computed ref. */
export interface Subscriber {
  readonly id: number;
  /** Becomes `false` once stopped; inactive subscribers are skipped when notifying. */
  active: boolean;
  /** Dependencies collected during the last run. */
  deps: Dep[] | undefined;
  /** Called when one of the subscribed dependencies changed. */
  notify(): void;
  /** Stops the subscriber and releases every dependency it holds. */
  teardown(): void;
}

let activeSub: Subscriber | undefined;
let trackingPaused = 0;
let notificationPaused = 0;
let pendingNotificationDeps: Set<Dep> | undefined;

export const getActiveSub = (): Subscriber | undefined => activeSub;

/** Replaces the active subscriber and returns the previous one (stack push/pop). */
export const setActiveSub = (sub: Subscriber | undefined): Subscriber | undefined => {
  const previous = activeSub;
  activeSub = sub;
  return previous;
};

/** `true` when a dependency read would currently be collected. */
export const isTracking = (): boolean => activeSub !== undefined && trackingPaused === 0;

/** Suspends dependency collection until `resumeTracking()`; calls nest. */
export const pauseTracking = (): void => {
  trackingPaused++;
};

export const resumeTracking = (): void => {
  if (trackingPaused > 0) trackingPaused--;
};

/** Runs `fn` without collecting any dependency. */
export function untrack<T>(fn: () => T): T {
  const previous = setActiveSub(undefined);
  try {
    return fn();
  } finally {
    activeSub = previous;
  }
}

/** Removes `sub` from every dependency it collected so far. */
export function cleanupDeps(sub: Subscriber): void {
  const deps = sub.deps;
  if (deps === undefined) return;
  for (let i = 0; i < deps.length; i++) deps[i]!.delete(sub);
  deps.length = 0;
}

/**
 * Defers notifications until the matching `resumeNotifications()`. Used by the array mutation
 * helpers so one `push()`/`splice()` notifies each touched dependency exactly once.
 */
export const pauseNotifications = (): void => {
  notificationPaused++;
};

export function resumeNotifications(): void {
  if (notificationPaused === 0) return;
  notificationPaused--;
  if (notificationPaused > 0) return;
  const pending = pendingNotificationDeps;
  if (pending === undefined) return;
  pendingNotificationDeps = undefined;
  for (const dep of pending) dep.notify();
}

/** A single tracked dependency: one property, one array index, one collection entry. */
export class Dep {
  /** Subscribers depending on this dep; allocated lazily to keep reads allocation free. */
  subscribers: Set<Subscriber> | undefined;
  /** Incremented on every trigger; a cheap "has it changed" marker for callers. */
  version = 0;

  /** Collects the active subscriber, if any. */
  track(): void {
    const sub = activeSub;
    if (sub === undefined || trackingPaused > 0 || !sub.active) return;
    let subscribers = this.subscribers;
    if (subscribers === undefined) this.subscribers = subscribers = new Set();
    if (subscribers.has(sub)) return;
    subscribers.add(sub);
    (sub.deps ??= []).push(this);
  }

  delete(sub: Subscriber): void {
    this.subscribers?.delete(sub);
  }

  /** Bumps the version and notifies subscribers (or batches them while notifications are paused). */
  trigger(): void {
    this.version++;
    if (notificationPaused > 0) {
      (pendingNotificationDeps ??= new Set()).add(this);
      return;
    }
    this.notify();
  }

  /** Notifies every active subscriber over a snapshot, so re-entrant writes stay safe. */
  notify(): void {
    const subscribers = this.subscribers;
    if (subscribers === undefined || subscribers.size === 0) return;
    const snapshot = acquireSnapshot(subscribers);
    try {
      for (let i = 0; i < snapshot.length; i++) {
        const sub = snapshot[i]!;
        if (sub.active) sub.notify();
      }
    } finally {
      releaseSnapshot();
    }
  }

  /** Drops every subscriber without stopping them (used when tearing a computed down). */
  clear(): void {
    this.subscribers?.clear();
  }
}

/**
 * Snapshot buffers are pooled per nesting depth, so notifying never allocates on the hot path
 * while still remaining safe when a notification re-enters `notify()`.
 */
const snapshotPool: Subscriber[][] = [];
let snapshotDepth = 0;

function acquireSnapshot(subscribers: Set<Subscriber>): Subscriber[] {
  let snapshot = snapshotPool[snapshotDepth];
  if (snapshot === undefined) snapshot = snapshotPool[snapshotDepth] = [];
  snapshotDepth++;
  snapshot.length = 0;
  for (const sub of subscribers) snapshot.push(sub);
  return snapshot;
}

function releaseSnapshot(): void {
  snapshotDepth--;
}
