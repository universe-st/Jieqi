/**
 * Shared primitives for the reactive kernel: type guards, comparison helpers and the internal
 * reactive flag keys. This module has no internal imports so every other module can depend on it
 * without creating a cycle.
 */

/** Property keys the proxies use to expose their internal metadata. */
export const ReactiveFlags = {
  /** Marks a value that must never be turned into a proxy (`markRaw`). */
  SKIP: '__mvvm_skip',
  IS_REACTIVE: '__mvvm_is_reactive',
  IS_READONLY: '__mvvm_is_readonly',
  IS_REF: '__mvvm_is_ref',
  RAW: '__mvvm_raw',
} as const;

/** Shared no-op used to keep call sites allocation free. */
export const NOOP = (): void => {};

export const hasOwnProperty = Object.prototype.hasOwnProperty;

/** `Object.prototype.hasOwnProperty` that accepts an untyped receiver. */
export const hasOwn = (value: object, key: PropertyKey): boolean => hasOwnProperty.call(value, key);

export const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

export const isFunction = (value: unknown): value is (...args: any[]) => any =>
  typeof value === 'function';

export const isString = (value: unknown): value is string => typeof value === 'string';

export const isSymbol = (value: unknown): value is symbol => typeof value === 'symbol';

export const isObject = (value: unknown): value is Record<PropertyKey, unknown> =>
  value !== null && typeof value === 'object';

export const toTypeString = (value: unknown): string => Object.prototype.toString.call(value);

/** `'Object'`, `'Array'`, `'Map'`, `'Date'`, … — the built-in brand of a value. */
export const toRawType = (value: unknown): string => toTypeString(value).slice(8, -1);

export const isMap = (value: unknown): value is Map<unknown, unknown> => toRawType(value) === 'Map';

export const isSet = (value: unknown): value is Set<unknown> => toRawType(value) === 'Set';

export const isDate = (value: unknown): value is Date => toRawType(value) === 'Date';

/** `true` for object literals and `Object.create(null)` objects, but not for class instances. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (toRawType(value) !== 'Object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};

/** Array index keys such as `'0'`; excludes `'-1'`, `'1.5'` and `'NaN'`. */
export const isIntegerKey = (key: unknown): key is string =>
  isString(key) && key !== 'NaN' && key[0] !== '-' && `${parseInt(key, 10)}` === key;

/**
 * `true` when two values differ. Based on `Object.is`, so `NaN` equals `NaN` and `+0`/`-0` differ.
 */
export const hasChanged = (value: unknown, oldValue: unknown): boolean =>
  !Object.is(value, oldValue);

export const extend = Object.assign;

/** Defines a non-enumerable, writable property (used for the internal flag keys). */
export const def = (target: object, key: PropertyKey, value: unknown): void => {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: false,
    value,
    writable: true,
  });
};

/** Well-known symbols whose access on a proxy must not be tracked. */
export const builtInSymbols: Set<symbol> = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map((key) => (Symbol as unknown as Record<string, unknown>)[key])
    .filter((value): value is symbol => isSymbol(value)),
);
