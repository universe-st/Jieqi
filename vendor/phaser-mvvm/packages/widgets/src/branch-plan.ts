/**
 * Which branch a `Branch` should build for a key.
 *
 * Split out from the widget because it is the one part with a right answer that plain data can express
 * — and because the wrong answer is a crash rather than a glitch. A branch map is an ordinary object,
 * so it inherits `Object.prototype`: looking a key up with `branches[key]` returns `Object`'s
 * `constructor`, `toString` or `__proto__` for those three spellings, and the widget then tries to
 * *call* it (`branches[key]()` → "… is not a constructor"). `planBranch` therefore asks for an **own**
 * property, and says `missing` when there is none, so the widget can warn instead.
 */

/** Builder of one branch: a content lambda, exactly like a page's. */
export type BranchBuilder = () => void;

/** A branch key as the DSL accepts it (`Branch` normalises numbers to strings). */
export type BranchKey = string | number | null | undefined;

export interface BranchPlan {
  /** Builder to run, or `null` for a key this map has no branch for. */
  builder: BranchBuilder | null;
  /** True when the key is not an own property of the map (including `null`/`undefined`). */
  missing: boolean;
  /** The key as it is looked up (numbers become strings; `null`/`undefined` stay `null`). */
  key: string | null;
}

/**
 * Resolves the builder for `key`.
 *
 * `missing` is reported separately from `builder: null` so the caller can distinguish "no such branch"
 * (warn, show nothing) from a branch that exists but is `undefined` in the map — which is the same
 * mistake, reported the same way, but worth having one answer for.
 */
export function planBranch(
  branches: Readonly<Record<string, BranchBuilder | undefined>>,
  key: BranchKey,
): BranchPlan {
  if (key === null || key === undefined) {
    return { builder: null, missing: true, key: null };
  }
  const name = String(key);
  if (!Object.prototype.hasOwnProperty.call(branches, name)) {
    return { builder: null, missing: true, key: name };
  }
  const builder = branches[name];
  if (typeof builder !== 'function') {
    return { builder: null, missing: true, key: name };
  }
  return { builder, missing: false, key: name };
}
