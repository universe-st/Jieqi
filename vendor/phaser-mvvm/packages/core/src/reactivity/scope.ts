/**
 * Effect scopes: ownership groups for effects, watchers and computed refs, so a single `stop()`
 * releases every dependency they collected. Nested scopes belong to the scope that created them;
 * `effectScope(true)` creates a detached scope that stops on its own.
 */

import type { Subscriber } from './dep';
import { warn } from '../utils/dev';

export interface EffectScope {
  /** `false` once the scope has been stopped. */
  readonly active: boolean;
  /** Runs `fn` with this scope active, collecting the subscribers it creates. */
  run<T>(fn: () => T): T | undefined;
  /** Stops every subscriber and cleanup callback registered in this scope. */
  stop(): void;
  /** Registers a callback that runs when the scope stops. */
  onScopeDispose(callback: () => void): void;
}

let activeScope: ScopeImpl | undefined;

class ScopeImpl implements EffectScope {
  private isActive = true;
  private readonly parent: ScopeImpl | undefined;
  private readonly subscribers: Subscriber[] = [];
  private cleanups: Array<() => void> = [];
  private children: ScopeImpl[] | undefined;

  constructor(parent: ScopeImpl | undefined) {
    this.parent = parent;
  }

  get active(): boolean {
    return this.isActive;
  }

  run<T>(fn: () => T): T | undefined {
    if (!this.isActive) {
      warn('Cannot run an effect scope that has already been stopped.');
      return undefined;
    }
    const previous = activeScope;
    const collectedBefore = this.subscribers.length;
    activeScope = this;
    try {
      return fn();
    } finally {
      activeScope = previous;
      // The scope may have been stopped while `fn` was running: stop what it created afterwards.
      if (!this.isActive && this.subscribers.length > collectedBefore) {
        for (let i = collectedBefore; i < this.subscribers.length; i++) {
          this.subscribers[i]!.teardown();
        }
        this.subscribers.length = collectedBefore;
      }
    }
  }

  add(sub: Subscriber): void {
    this.subscribers.push(sub);
  }

  addChild(child: ScopeImpl): void {
    (this.children ??= []).push(child);
  }

  onScopeDispose(callback: () => void): void {
    this.cleanups.push(callback);
  }

  stop(): void {
    if (!this.isActive) return;
    this.isActive = false;

    const parent = this.parent;
    if (parent !== undefined && parent.children !== undefined) {
      const index = parent.children.indexOf(this);
      if (index >= 0) parent.children.splice(index, 1);
    }

    const subscribers = this.subscribers;
    for (let i = 0; i < subscribers.length; i++) subscribers[i]!.teardown();
    subscribers.length = 0;

    const children = this.children;
    this.children = undefined;
    if (children !== undefined) {
      for (let i = 0; i < children.length; i++) children[i]!.stop();
    }

    const cleanups = this.cleanups;
    this.cleanups = [];
    for (let i = 0; i < cleanups.length; i++) {
      try {
        cleanups[i]!();
      } catch (error) {
        warn(`Unhandled error in an onScopeDispose() callback: ${String(error)}`, false);
      }
    }
  }
}

/** Creates a scope; `detached` scopes are not owned by the scope that creates them. */
export function effectScope(detached = false): EffectScope {
  const parent = detached ? undefined : activeScope;
  const scope = new ScopeImpl(parent);
  parent?.addChild(scope);
  return scope;
}

/** The scope `run()` is currently executing in, if any. */
export function getCurrentScope(): EffectScope | undefined {
  return activeScope;
}

/** Registers a cleanup callback on the active scope. */
export function onScopeDispose(callback: () => void): void {
  const scope = activeScope;
  if (scope !== undefined) {
    scope.onScopeDispose(callback);
    return;
  }
  warn('onScopeDispose() was called outside of an active effect scope.');
}

/** Internal hook used by effects/computeds so they can be stopped together with their scope. */
export function recordScope(sub: Subscriber, scope?: EffectScope): void {
  const target = scope ?? activeScope;
  if (target instanceof ScopeImpl) target.add(sub);
}
