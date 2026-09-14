/**
 * Mutable references. `ref` deeply converts object values through `reactive`, `shallowRef` stores
 * them untouched; both expose a tracked `value` accessor and are recognised by `isRef()`.
 *
 * Internal state uses ECMAScript private fields, so a ref stays a clean single-value container for
 * `Object.keys()`, spreads and `JSON.stringify()` (the `value` accessor lives on the prototype).
 */

import { Dep } from './dep';
import { toReactive } from './reactive';
import { ReactiveFlags, def, hasChanged, isObject } from '../utils/shared';
import { warn } from '../utils/dev';

/** A mutable, tracked container for a single value. */
export interface Ref<T = unknown> {
  value: T;
}

/** A ref created by `ref()`/`shallowRef()`/`customRef()`, with the extra inspection helpers. */
export interface MutableRef<T = unknown> extends Ref<T> {
  /** Reads the current value without collecting a dependency. */
  peek(): T;
  /** Forces a notification even though the value did not change. */
  trigger(): void;
}

/** A ref that never converts its (object) value into a proxy. */
export type ShallowRef<T = unknown> = Ref<T>;

/** Factory used by `customRef()`. */
export interface CustomRefFactory<T> {
  (track: () => void, trigger: () => void): { get(): T; set(value: T): void };
}

/** Creates a deeply reactive ref: reading `.value` inside an effect tracks it. */
export function ref<T>(value: T): MutableRef<T> {
  return new RefImpl<T>(value, false);
}

/** Creates a ref that tracks reassignment only — nested mutation of an object value is invisible. */
export function shallowRef<T>(value: T): MutableRef<T> {
  return new RefImpl<T>(value, true);
}

export function isRef<T>(value: Ref<T> | unknown): value is Ref<T> {
  return isObject(value) && (value as Record<string, unknown>)[ReactiveFlags.IS_REF] === true;
}

/** Reads a ref's value, or returns the value itself when it is not a ref. */
export function unref<T>(value: T | Ref<T>): T {
  return isRef(value) ? (value.value as T) : (value as T);
}

/** Forces a notification even though `.value` was not assigned a new value. */
export function triggerRef(value: Ref<unknown>): void {
  if (isRef(value) && typeof (value as { trigger?: unknown }).trigger === 'function') {
    (value as unknown as { trigger(): void }).trigger();
    return;
  }
  warn('triggerRef() expects a ref created by ref() or shallowRef().');
}

/** Creates a ref whose read/write behaviour is provided by `factory`. */
export function customRef<T>(factory: CustomRefFactory<T>): MutableRef<T> {
  return new CustomRefImpl<T>(factory);
}

class RefImpl<T> implements MutableRef<T> {
  #dep = new Dep();
  #rawValue: T;
  #storedValue: T;
  #shallow: boolean;

  constructor(value: T, shallow: boolean) {
    def(this, ReactiveFlags.IS_REF, true);
    this.#shallow = shallow;
    this.#rawValue = value;
    this.#storedValue = shallow ? value : toReactive(value);
  }

  get value(): T {
    this.#dep.track();
    return this.#storedValue;
  }

  set value(next: T) {
    if (!hasChanged(next, this.#rawValue)) return;
    this.#rawValue = next;
    this.#storedValue = this.#shallow ? next : toReactive(next);
    this.#dep.trigger();
  }

  peek(): T {
    return this.#storedValue;
  }

  trigger(): void {
    this.#dep.trigger();
  }
}

class CustomRefImpl<T> implements MutableRef<T> {
  #dep = new Dep();
  #getter: () => T;
  #setter: (value: T) => void;

  constructor(factory: CustomRefFactory<T>) {
    def(this, ReactiveFlags.IS_REF, true);
    const { get, set } = factory(
      () => this.#dep.track(),
      () => this.#dep.trigger(),
    );
    this.#getter = get;
    this.#setter = set;
  }

  get value(): T {
    return this.#getter();
  }

  set value(next: T) {
    this.#setter(next);
  }

  peek(): T {
    return this.#getter();
  }

  trigger(): void {
    this.#dep.trigger();
  }
}
