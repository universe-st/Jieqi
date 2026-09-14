/**
 * Structural comparison used by deep watchers and `deep: true` change checks. Comparison follows
 * `Object.is` semantics (so `NaN` equals `NaN`) and tolerates cyclic references.
 */

import { isArray, isDate, isMap, isPlainObject, isSet } from './shared';

const hasOwnProperty = Object.prototype.hasOwnProperty;

/**
 * Deeply compares two values.
 *
 * Plain objects, arrays, `Map`, `Set` and `Date` are compared structurally; anything else (class
 * instances, functions, symbols) is only equal by identity.
 */
export function deepEqual(a: unknown, b: unknown, seen?: Map<object, object>): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;

  // Guards against cyclic structures: a pair already being compared is assumed equal.
  const visited = seen ?? new Map<object, object>();
  const previous = visited.get(a);
  if (previous !== undefined) return previous === b;
  // The pair is remembered only for as long as this comparison path is open: keeping it after the
  // branch returns would make the walk order-dependent (and `deepEqual` asymmetric), because a
  // sub-object aliased twice on the left would be matched against the first right-hand object for
  // the rest of the walk. Cyclic structures still terminate — an ancestor pair is on the path.
  visited.set(a, b);
  try {
    return compareObjects(a, b, visited);
  } finally {
    visited.delete(a);
  }
}

/** The structural comparison itself, with the cycle guard already installed by `deepEqual`. */
function compareObjects(a: object, b: object, visited: Map<object, object>): boolean {
  if (isArray(a)) {
    if (!isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i], visited)) return false;
    }
    return true;
  }

  if (isDate(a)) return isDate(b) && Object.is(a.getTime(), b.getTime());

  if (isMap(a)) {
    if (!isMap(b) || a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !deepEqual(value, b.get(key), visited)) return false;
    }
    return true;
  }

  if (isSet(a)) {
    if (!isSet(b) || a.size !== b.size) return false;
    for (const value of a) {
      if (!b.has(value)) return false;
    }
    return true;
  }

  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (!hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key], visited)) return false;
    }
    return true;
  }

  return false;
}
