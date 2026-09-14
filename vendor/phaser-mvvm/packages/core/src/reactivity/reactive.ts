/**
 * Deep reactive proxies for plain objects, arrays, `Map` and `Set`, plus their readonly variants.
 *
 * - Proxies are cached per target, so `reactive(obj) === reactive(obj)`.
 * - Reads are tracked per property key, writes notify only the keys that really changed.
 * - Array mutators (`push`, `splice`, `sort`, …) notify each touched index once per call.
 * - Values that cannot be proxied (class instances, `Date`, frozen objects, `markRaw`ed values)
 *   are returned unchanged so a ViewModel may safely hold framework objects.
 */

import type { Ref } from './ref';
import { Dep, isTracking, pauseNotifications, resumeNotifications } from './dep';
import {
  ReactiveFlags,
  def,
  hasChanged,
  hasOwn,
  isArray,
  isIntegerKey,
  isObject,
  isPlainObject,
  isSymbol,
  toRawType,
  builtInSymbols,
} from '../utils/shared';
import { warn } from '../utils/dev';

/** Iteration dependency used by `ownKeys`, `for…in` and collection iteration. */
export const ITERATE_KEY: unique symbol = Symbol('mvvm:iterate');

const targetMap = new WeakMap<object, Map<unknown, Dep>>();
const reactiveMap = new WeakMap<object, object>();
const shallowReactiveMap = new WeakMap<object, object>();
const readonlyMap = new WeakMap<object, object>();
const shallowReadonlyMap = new WeakMap<object, object>();

const TARGET_INVALID = 0;
const TARGET_COMMON = 1;
const TARGET_COLLECTION = 2;
type TargetType = typeof TARGET_INVALID | typeof TARGET_COMMON | typeof TARGET_COLLECTION;

type AnyRecord = Record<PropertyKey, unknown>;
type TriggerType = 'add' | 'set' | 'delete' | 'clear';

/** Deep readonly view of `T`; refs keep tracking but lose their setter. */
export type DeepReadonly<T> =
  T extends Ref<infer V>
    ? Readonly<Ref<V>>
    : T extends (...args: any[]) => unknown
      ? T
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

/**
 * Classifies a target for proxy creation. Only plain objects, arrays, `Map` and `Set` are observed;
 * class instances (`Date`, `Vector2`, Phaser game objects, …) keep their identity, so a ViewModel can
 * hold framework objects without turning them into proxies.
 */
function getTargetType(value: object): TargetType {
  const raw = toRaw(value);
  if ((raw as AnyRecord)[ReactiveFlags.SKIP] === true || !Object.isExtensible(raw)) {
    return TARGET_INVALID;
  }
  const type = toRawType(raw);
  if (type === 'Array') return TARGET_COMMON;
  if (type === 'Map' || type === 'Set') return TARGET_COLLECTION;
  return isPlainObject(raw) ? TARGET_COMMON : TARGET_INVALID;
}

/** Converts object values into reactive proxies; primitives and unsupported objects pass through. */
export const toReactive = <T>(value: T): T => {
  if (!isObject(value) || getTargetType(value) === TARGET_INVALID) return value;
  return reactive(value as object) as T;
};

/** A reactive proxy of `target` (same proxy for the same target). */
export function reactive<T extends object>(target: T): T {
  if (isObject(target) && (target as AnyRecord)[ReactiveFlags.IS_READONLY] === true) return target;
  return createReactiveObject(target, false, mutableHandlers, collectionHandlers, reactiveMap) as T;
}

/** A proxy that tracks top-level writes only; nested objects stay raw. */
export function shallowReactive<T extends object>(target: T): T {
  return createReactiveObject(
    target,
    false,
    shallowReactiveHandlers,
    collectionHandlers,
    shallowReactiveMap,
  ) as T;
}

/** A readonly view of `target`; writes are ignored and reported in development mode. */
export function readonly<T>(target: T): DeepReadonly<T> {
  if (isObject(target) && (target as AnyRecord)[ReactiveFlags.IS_REF] === true) {
    return createReadonlyRef(target as unknown as Ref<unknown>) as unknown as DeepReadonly<T>;
  }
  return createReactiveObject(
    target as object,
    true,
    readonlyHandlers,
    collectionHandlers,
    readonlyMap,
  ) as unknown as DeepReadonly<T>;
}

/** A shallow readonly view: only top-level reads are tracked, nested values stay raw. */
export function shallowReadonly<T>(target: T): DeepReadonly<T> {
  return createReactiveObject(
    target as object,
    true,
    shallowReadonlyHandlers,
    collectionHandlers,
    shallowReadonlyMap,
  ) as unknown as DeepReadonly<T>;
}

export function isReactive(value: unknown): boolean {
  return isObject(value) && (value as AnyRecord)[ReactiveFlags.IS_REACTIVE] === true;
}

export function isReadonly(value: unknown): boolean {
  return isObject(value) && (value as AnyRecord)[ReactiveFlags.IS_READONLY] === true;
}

export function isProxy(value: unknown): boolean {
  return isReactive(value) || isReadonly(value);
}

/** Returns the raw object behind a reactive/readonly proxy (or the value itself). */
export function toRaw<T>(observed: T): T {
  const raw = isObject(observed) ? (observed as AnyRecord)[ReactiveFlags.RAW] : undefined;
  return raw !== undefined && raw !== null ? toRaw(raw as T) : observed;
}

/** Opts a value out of reactive conversion (it will never be proxied). */
export function markRaw<T extends object>(value: T): T {
  def(value, ReactiveFlags.SKIP, true);
  return value;
}

function createReactiveObject(
  target: object,
  isReadonlyMode: boolean,
  baseHandlers: ProxyHandler<object>,
  collections: ProxyHandler<CollectionTypes>,
  proxyMap: WeakMap<object, object>,
): object {
  if (!isObject(target)) {
    warn(`Cannot make a ${typeof target} reactive; only objects can be observed.`);
    return target;
  }
  if (
    (target as AnyRecord)[ReactiveFlags.RAW] !== undefined &&
    !(isReadonlyMode && isReactive(target))
  ) {
    return target;
  }
  const existing = proxyMap.get(target);
  if (existing !== undefined) return existing;

  const targetType = getTargetType(target);
  if (targetType === TARGET_INVALID) {
    warn(
      `Cannot make a ${toRawType(target)} reactive: only plain objects, arrays, Map and Set are supported.`,
    );
    return target;
  }
  if (isReadonlyMode && targetType === TARGET_COLLECTION) {
    warn('readonly() does not support Map/Set yet; the collection is returned unchanged.');
    return target;
  }

  const proxy =
    targetType === TARGET_COLLECTION
      ? new Proxy(target as unknown as CollectionTypes, collections)
      : new Proxy(target, baseHandlers);
  proxyMap.set(target, proxy);
  return proxy;
}

function createReadonlyRef(source: Ref<unknown>): { readonly value: unknown; peek(): unknown } {
  const wrapper = {
    get value(): unknown {
      return source.value;
    },
    peek: (): unknown => source.value,
    // Forwarded so `triggerRef(readonly(r))` still works; the setter stays absent.
    trigger: (): void => {
      const trigger = (source as { trigger?: () => void }).trigger;
      if (typeof trigger === 'function') trigger.call(source);
    },
  };
  // Both flags: the view is readonly *and* a ref. Without `IS_REF`, `isRef`/`unref`/`watch` treated
  // the wrapper as a plain object, contradicting the declared `DeepReadonly<Ref<T>>` type.
  def(wrapper, ReactiveFlags.IS_READONLY, true);
  def(wrapper, ReactiveFlags.IS_REF, true);
  return wrapper;
}

/* ------------------------------------------------------------------------------------------------
 * Dependency bookkeeping
 * ---------------------------------------------------------------------------------------------- */

function getDep(target: object, key: unknown, create: boolean): Dep | undefined {
  let depsMap = targetMap.get(target);
  if (depsMap === undefined) {
    if (!create) return undefined;
    depsMap = new Map();
    targetMap.set(target, depsMap);
  }
  let dep = depsMap.get(key);
  if (dep === undefined) {
    if (!create) return undefined;
    dep = new Dep();
    depsMap.set(key, dep);
  }
  return dep;
}

function track(target: object, key: unknown): void {
  if (!isTracking()) return;
  getDep(target, key, true)!.track();
}

function trigger(target: object, type: TriggerType, key: unknown, newLength?: number): void {
  const depsMap = targetMap.get(target);
  if (depsMap === undefined) return;

  if (type === 'clear') {
    // Snapshot first: running an effect may add new deps to the same map.
    for (const dep of Array.from(depsMap.values())) dep.trigger();
    return;
  }

  depsMap.get(key)?.trigger();

  if (type === 'add' || type === 'delete') {
    depsMap.get(ITERATE_KEY)?.trigger();
    return;
  }

  // Shrinking an array through `length = n` invalidates every dropped index.
  if (newLength !== undefined && isArray(target)) {
    for (const [depKey, indexDep] of Array.from(depsMap)) {
      if (isIntegerKey(depKey) && Number(depKey) >= newLength) indexDep.trigger();
    }
  }
}

function triggerKey(target: object, key: unknown): void {
  targetMap.get(target)?.get(key)?.trigger();
}

/**
 * Number of subscribers currently attached to one key of a reactive target.
 *
 * Diagnostics helper: tests use it to assert that stopping an effect/scope really released its
 * dependencies instead of leaving them behind.
 */
export function getDepSize(target: object, key: unknown = ITERATE_KEY): number {
  const dep = targetMap.get(toRaw(target))?.get(key);
  return dep?.subscribers?.size ?? 0;
}

function triggerIndexRange(target: unknown[], from: number, to: number): void {
  const depsMap = targetMap.get(target);
  if (depsMap === undefined || to <= from) return;
  for (const [key, dep] of Array.from(depsMap)) {
    if (isIntegerKey(key)) {
      const index = Number(key);
      if (index >= from && index < to) dep.trigger();
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Object / array handlers
 * ---------------------------------------------------------------------------------------------- */

function createGetter(
  isReadonlyMode: boolean,
  shallow: boolean,
  proxyMap: WeakMap<object, object>,
) {
  return function get(target: object, key: string | symbol, receiver: object): unknown {
    if (key === ReactiveFlags.IS_REACTIVE) return !isReadonlyMode;
    if (key === ReactiveFlags.IS_READONLY) return isReadonlyMode;
    if (key === ReactiveFlags.RAW && receiver === proxyMap.get(target)) return target;

    if (!isReadonlyMode && isArray(target) && hasOwn(arrayInstrumentations, key)) {
      return arrayInstrumentations[key as string];
    }

    const result = Reflect.get(target, key, receiver);
    if (isSymbol(key) && builtInSymbols.has(key)) return result;

    track(target, key);
    if (shallow) return result;
    if (isObject(result) && getTargetType(result) !== TARGET_INVALID) {
      return isReadonlyMode ? readonly(result) : reactive(result);
    }
    return result;
  };
}

function createSetter() {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object,
  ): boolean {
    const oldValue = (target as AnyRecord)[key];
    const hadKey =
      isArray(target) && isIntegerKey(key) ? Number(key) < target.length : hasOwn(target, key);
    const oldLength = isArray(target) ? target.length : 0;

    const result = Reflect.set(target, key, value, receiver);

    // Only report changes made through this proxy, not through a nested receiver.
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        trigger(target, 'add', key);
        if (isArray(target) && target.length !== oldLength) {
          trigger(target, 'set', 'length', target.length);
        }
      } else if (hasChanged(value, oldValue)) {
        trigger(target, 'set', key, key === 'length' ? Number(value) : undefined);
      }
    }
    return result;
  };
}

function hasHandler(target: object, key: string | symbol): boolean {
  track(target, key);
  return Reflect.has(target, key);
}

function ownKeysHandler(target: object): ArrayLike<string | symbol> {
  track(target, isArray(target) ? 'length' : ITERATE_KEY);
  return Reflect.ownKeys(target);
}

function deletePropertyHandler(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key);
  const result = Reflect.deleteProperty(target, key);
  if (result && hadKey) trigger(target, 'delete', key);
  return result;
}

function readonlySetHandler(_target: object, key: string | symbol): boolean {
  warn(`Set operation on key "${String(key)}" failed: the target is readonly.`);
  return true;
}

function readonlyDeleteHandler(_target: object, key: string | symbol): boolean {
  warn(`Delete operation on key "${String(key)}" failed: the target is readonly.`);
  return true;
}

const mutableHandlers: ProxyHandler<object> = {
  get: createGetter(false, false, reactiveMap),
  set: createSetter(),
  has: hasHandler,
  ownKeys: ownKeysHandler,
  deleteProperty: deletePropertyHandler,
};

const shallowReactiveHandlers: ProxyHandler<object> = {
  get: createGetter(false, true, shallowReactiveMap),
  set: createSetter(),
  has: hasHandler,
  ownKeys: ownKeysHandler,
  deleteProperty: deletePropertyHandler,
};

const readonlyHandlers: ProxyHandler<object> = {
  get: createGetter(true, false, readonlyMap),
  set: readonlySetHandler,
  has: hasHandler,
  ownKeys: ownKeysHandler,
  deleteProperty: readonlyDeleteHandler,
};

const shallowReadonlyHandlers: ProxyHandler<object> = {
  get: createGetter(true, true, shallowReadonlyMap),
  set: readonlySetHandler,
  has: hasHandler,
  ownKeys: ownKeysHandler,
  deleteProperty: readonlyDeleteHandler,
};

/* ------------------------------------------------------------------------------------------------
 * Array instrumentation
 * ---------------------------------------------------------------------------------------------- */

type ArrayMutationMethod =
  'push' | 'pop' | 'shift' | 'unshift' | 'splice' | 'sort' | 'reverse' | 'fill' | 'copyWithin';

const arrayInstrumentations: Record<string, unknown> = {};

function applyArrayMethod(list: unknown[], method: string, args: unknown[]): unknown {
  return (Array.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[
    method
  ]!.apply(list, args);
}

/** `includes`/`indexOf`/`lastIndexOf` must look for raw values when given a proxy. */
(['includes', 'indexOf', 'lastIndexOf'] as const).forEach((method) => {
  arrayInstrumentations[method] = function instrumentedSearch(
    this: unknown[],
    ...args: unknown[]
  ): unknown {
    const raw = toRaw(this) as unknown[];
    for (let i = 0; i < raw.length; i++) track(raw, `${i}`);
    const searched = args.map((arg) => (isObject(arg) ? toRaw(arg) : arg));
    const result = applyArrayMethod(raw, method, searched);
    if (result === false || result === -1) return applyArrayMethod(raw, method, args);
    return result;
  };
});

const normalizeStart = (value: unknown, length: number): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  const start = value < 0 ? length + value : value;
  return start < 0 ? 0 : start > length ? length : Math.trunc(start);
};

function triggerArrayMutation(
  target: unknown[],
  method: ArrayMutationMethod,
  oldLength: number,
  newLength: number,
  start: number,
): void {
  switch (method) {
    case 'push':
      triggerIndexRange(target, oldLength, newLength);
      break;
    case 'pop':
      triggerIndexRange(target, newLength, oldLength);
      break;
    case 'shift':
      triggerIndexRange(target, 0, Math.max(oldLength, newLength));
      break;
    case 'unshift':
      triggerIndexRange(target, 0, newLength);
      break;
    case 'splice':
      triggerIndexRange(target, start, Math.max(oldLength, newLength));
      break;
    case 'fill':
    case 'copyWithin':
      triggerIndexRange(target, 0, newLength);
      break;
    case 'sort':
    case 'reverse':
      triggerIndexRange(target, 0, oldLength);
      break;
  }
  if (newLength !== oldLength) triggerKey(target, 'length');
  // Iteration deps (`Object.keys`, `for…of` over the proxy) only change with the key set.
  if (newLength !== oldLength) triggerKey(target, ITERATE_KEY);
}

(
  ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'] as const
).forEach((method) => {
  arrayInstrumentations[method] = function instrumentedMutation(
    this: unknown[],
    ...args: unknown[]
  ): unknown {
    const raw = toRaw(this) as unknown[];
    const oldLength = raw.length;
    const start = normalizeStart(args[0], oldLength);
    pauseNotifications();
    try {
      return applyArrayMethod(raw, method, args);
    } finally {
      // Every touched key is notified exactly once per mutation call.
      try {
        triggerArrayMutation(raw, method, oldLength, raw.length, start);
      } finally {
        resumeNotifications();
      }
    }
  };
});

/* ------------------------------------------------------------------------------------------------
 * Map / Set instrumentation
 * ---------------------------------------------------------------------------------------------- */

type CollectionTypes = Map<unknown, unknown> | Set<unknown>;

const wrapValue = (value: unknown): unknown => toReactive(value);

function wrapValues(iterator: IterableIterator<unknown>): IterableIterator<unknown> {
  const wrapped: IterableIterator<unknown> = {
    next(): IteratorResult<unknown> {
      const result = iterator.next();
      if (result.done === true) return { done: true, value: undefined };
      return { done: false, value: wrapValue(result.value) };
    },
    [Symbol.iterator](): IterableIterator<unknown> {
      return wrapped;
    },
  };
  return wrapped;
}

function wrapEntries(iterator: IterableIterator<[unknown, unknown]>): IterableIterator<unknown> {
  const wrapped: IterableIterator<unknown> = {
    next(): IteratorResult<unknown> {
      const result = iterator.next();
      if (result.done === true) return { done: true, value: undefined };
      return { done: false, value: [wrapValue(result.value[0]), wrapValue(result.value[1])] };
    },
    [Symbol.iterator](): IterableIterator<unknown> {
      return wrapped;
    },
  };
  return wrapped;
}

/** True when `receiver` is the proxy registered for `target` in any of the four proxy maps. */
function isProxyOf(target: object, receiver: unknown): boolean {
  return (
    reactiveMap.get(target) === receiver ||
    shallowReactiveMap.get(target) === receiver ||
    readonlyMap.get(target) === receiver ||
    shallowReadonlyMap.get(target) === receiver
  );
}

function mapGet(this: Map<unknown, unknown>, key: unknown): unknown {
  const target = toRaw(this);
  track(target, key);
  return wrapValue(target.get(key));
}

function mapHas(this: Map<unknown, unknown>, key: unknown): boolean {
  const target = toRaw(this);
  track(target, key);
  return target.has(key);
}

function mapSet(this: Map<unknown, unknown>, key: unknown, value: unknown): unknown {
  const target = toRaw(this);
  const hadKey = target.has(key);
  const oldValue = target.get(key);
  target.set(key, value);
  if (!hadKey) trigger(target, 'add', key);
  else if (hasChanged(value, oldValue)) trigger(target, 'set', key);
  return this;
}

function mapDelete(this: Map<unknown, unknown>, key: unknown): boolean {
  const target = toRaw(this);
  const hadKey = target.has(key);
  const result = target.delete(key);
  if (hadKey) trigger(target, 'delete', key);
  return result;
}

function mapClear(this: Map<unknown, unknown>): void {
  const target = toRaw(this);
  const hadEntries = target.size > 0;
  target.clear();
  if (hadEntries) trigger(target, 'clear', ITERATE_KEY);
}

function mapForEach(
  this: Map<unknown, unknown>,
  callback: (value: unknown, key: unknown, map: unknown) => void,
  thisArg?: unknown,
): void {
  const target = toRaw(this);
  track(target, ITERATE_KEY);
  target.forEach((value, key) => {
    callback.call(thisArg, wrapValue(value), wrapValue(key), this);
  });
}

function mapKeys(this: Map<unknown, unknown>): IterableIterator<unknown> {
  const target = toRaw(this);
  track(target, ITERATE_KEY);
  return wrapValues(target.keys());
}

function mapValues(this: Map<unknown, unknown>): IterableIterator<unknown> {
  const target = toRaw(this);
  track(target, ITERATE_KEY);
  return wrapValues(target.values());
}

function mapEntries(this: Map<unknown, unknown>): IterableIterator<unknown> {
  const target = toRaw(this);
  track(target, ITERATE_KEY);
  return wrapEntries(target.entries());
}

function setHas(this: Set<unknown>, value: unknown): boolean {
  const target = toRaw(this);
  track(target, value);
  return target.has(value);
}

function setAdd(this: Set<unknown>, value: unknown): unknown {
  const target = toRaw(this);
  const hadValue = target.has(value);
  target.add(value);
  if (!hadValue) trigger(target, 'add', value);
  return this;
}

function setDelete(this: Set<unknown>, value: unknown): boolean {
  const target = toRaw(this);
  const hadValue = target.has(value);
  const result = target.delete(value);
  if (hadValue) trigger(target, 'delete', value);
  return result;
}

function setClear(this: Set<unknown>): void {
  const target = toRaw(this);
  const hadValues = target.size > 0;
  target.clear();
  if (hadValues) trigger(target, 'clear', ITERATE_KEY);
}

function setForEach(
  this: Set<unknown>,
  callback: (value: unknown, key: unknown, set: unknown) => void,
  thisArg?: unknown,
): void {
  const target = toRaw(this);
  track(target, ITERATE_KEY);
  target.forEach((value) => {
    callback.call(thisArg, wrapValue(value), wrapValue(value), this);
  });
}

function setValues(this: Set<unknown>): IterableIterator<unknown> {
  const target = toRaw(this);
  track(target, ITERATE_KEY);
  return wrapValues(target.values());
}

function setEntries(this: Set<unknown>): IterableIterator<unknown> {
  const target = toRaw(this);
  track(target, ITERATE_KEY);
  return wrapEntries(
    (function* entries(): Generator<[unknown, unknown]> {
      for (const value of target.values()) yield [value, value];
    })(),
  );
}

type Instrumentation = (...args: any[]) => any;

const mapInstrumentations: Record<string | symbol, Instrumentation> = {
  get: mapGet,
  has: mapHas,
  set: mapSet,
  delete: mapDelete,
  clear: mapClear,
  forEach: mapForEach,
  keys: mapKeys,
  values: mapValues,
  entries: mapEntries,
  [Symbol.iterator]: mapEntries,
};

const setInstrumentations: Record<string | symbol, Instrumentation> = {
  has: setHas,
  add: setAdd,
  delete: setDelete,
  clear: setClear,
  forEach: setForEach,
  keys: setValues,
  values: setValues,
  entries: setEntries,
  [Symbol.iterator]: setValues,
};

const collectionHandlers: ProxyHandler<CollectionTypes> = {
  get(target, key, receiver) {
    if (key === ReactiveFlags.IS_REACTIVE) return true;
    if (key === ReactiveFlags.IS_READONLY) return false;
    // A collection proxy can come from `reactive`, `shallowReactive`, `readonly` or
    // `shallowReadonly`, and `toRaw()` has to unwrap all of them: accepting only `reactiveMap` made
    // every instrumented method of a shallow collection proxy re-enter itself (stack overflow).
    if (key === ReactiveFlags.RAW && isProxyOf(target, receiver)) return target;

    if (key === 'size') {
      track(target, ITERATE_KEY);
      return target.size;
    }
    const instrumentations = target instanceof Map ? mapInstrumentations : setInstrumentations;
    if (hasOwn(instrumentations, key)) return instrumentations[key as string];
    return Reflect.get(target, key, target);
  },
  has(target, key) {
    return Reflect.has(target, key);
  },
};
