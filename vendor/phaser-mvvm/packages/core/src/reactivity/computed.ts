/**
 * Lazily evaluated, cached derived values.
 *
 * A computed only runs when something reads it, caches the result until one of its dependencies
 * changes, and re-evaluates on the next read only. It registers itself in the active effect scope
 * like an effect, so stopping the scope releases its dependencies too.
 */

import type { Subscriber } from './dep';
import { Dep, cleanupDeps, setActiveSub } from './dep';
import type { EffectScope } from './scope';
import { recordScope } from './scope';
import { ReactiveFlags, def } from '../utils/shared';
import { RECURSION_LIMIT, recursiveUpdateError, warn } from '../utils/dev';

/** A readonly derived value. */
export interface ComputedRef<T = unknown> {
  readonly value: T;
  /** Reads the cached value without collecting a dependency. */
  peek(): T;
}

export interface ComputedOptions {
  /** Scope to attach to instead of the currently active one. */
  scope?: EffectScope;
}

let computedUid = 0;

export class ComputedRefImpl<T = unknown> implements ComputedRef<T>, Subscriber {
  readonly id: number = ++computedUid;
  active = true;
  deps: Dep[] | undefined;

  /** Consumers of this computed (effects and other computeds). */
  #dep = new Dep();
  #getter: () => T;
  #cachedValue!: T;
  #dirty = true;
  #evaluating = 0;

  constructor(getter: () => T, options: ComputedOptions = {}) {
    def(this, ReactiveFlags.IS_REF, true);
    this.#getter = getter;
    recordScope(this, options.scope);
  }

  get value(): T {
    if (!this.active) return this.#getter();
    this.#dep.track();
    if (this.#dirty) this.evaluate();
    return this.#cachedValue;
  }

  peek(): T {
    if (this.#dirty) this.evaluate();
    return this.#cachedValue;
  }

  /** A dependency changed: invalidate and forward the invalidation to consumers. */
  notify(): void {
    this.#dirty = true;
    this.#dep.trigger();
  }

  teardown(): void {
    if (!this.active) return;
    this.active = false;
    cleanupDeps(this);
    this.#dep.clear();
    this.#dirty = true;
  }

  private evaluate(): void {
    if (this.#evaluating >= RECURSION_LIMIT) {
      const error = recursiveUpdateError(`computed #${this.id}`);
      warn(error.message, false);
      throw error;
    }
    this.#evaluating++;
    cleanupDeps(this);
    // Cleared before running so a getter that invalidates itself stays invalidated.
    this.#dirty = false;
    const previous = setActiveSub(this);
    try {
      this.#cachedValue = this.#getter();
    } catch (error) {
      // A throwing getter produced no value, so the cache must not look fresh afterwards: otherwise
      // every later read would silently return the previous value (or `undefined`) without re-running
      // the getter, hiding the error.
      this.#dirty = true;
      throw error;
    } finally {
      setActiveSub(previous);
      this.#evaluating--;
    }
  }
}

/** Creates a cached, lazily evaluated derived value. */
export function computed<T>(getter: () => T, options?: ComputedOptions): ComputedRef<T> {
  return new ComputedRefImpl<T>(getter, options);
}
