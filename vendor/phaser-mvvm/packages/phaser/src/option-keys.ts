/**
 * The option audit: telling a caller that an option it passed does not exist.
 *
 * Widget options are flat objects — node-level `LayoutParams` (`width`, `padding`, …) mixed with the
 * widget's own keys (`text`, `variant`, `maxLength`, …) — and both `splitOptions` and
 * `splitWidgetOptions` move unknown keys into the params bag, where `normalizeParams` ignores them. That
 * is fine for the *design* (it is what lets one object be handed to any container), and terrible for the
 * *user*: `TextField({ maxlength: 8 })` or `Panel({ pading: 10 })` used to produce a control that simply
 * ignores the option, with no error, no warning and no log line. The guide even documented it as
 * "unknown keys are silently ignored", which is exactly the kind of trap this framework should not have.
 *
 * So every construction now checks the bag (development mode only, one warning per distinct key) and
 * says what it did not understand, with a suggestion when one is obvious.
 *
 * The matching is pure and lives here — no Phaser, no scene — so it is unit-testable in Node, and the
 * demo sweep is the other half of the gate: a page full of every option in the library must produce no
 * warning at all, which is what keeps {@link LAYOUT_PARAM_KEYS} and the widgets' own key lists honest.
 */

import { LAYOUT_PARAM_KEYS } from '@phaser-mvvm/layout';
import { isDevMode, warn } from '@phaser-mvvm/core';

/**
 * Options every widget accepts on the base class, so they may ride along in any bag.
 *
 * `visible`, `focusOrder`, `label` and the two pointer-chain hooks are read by `baseWidgetOptions()`;
 * `name` by `splitOptions` itself. They are not layout params and usually not in a widget's own key
 * list.
 */
export const BASE_WIDGET_OPTION_KEYS: readonly string[] = [
  'name',
  'visible',
  'focusOrder',
  'label',
  'onPointerIntercept',
  'onPointerEvent',
];

/** The layout keys, as a `Set` for the hot path. */
const LAYOUT_KEYS: ReadonlySet<string> = new Set<string>(LAYOUT_PARAM_KEYS as readonly string[]);

/**
 * The closest known key to `key`, or `null` when nothing is close enough.
 *
 * Three passes, cheapest first: an exact case-insensitive match (`maxlength` → `maxLength`), then a
 * containment match (`fillw` → `width` is *not* one of these, but `alignself` → `alignSelf` is), then
 * edit distance ≤ 2 (`pading` → `padding`, `widht` → `width`). A suggestion is only offered when the
 * result is unambiguous: two equally close keys means the typo is not obvious, and guessing wrong is
 * worse than saying nothing.
 */
export function suggestOptionKey(key: string, known: readonly string[]): string | null {
  const lower = key.toLowerCase();

  const exact = known.filter((candidate) => candidate.toLowerCase() === lower);
  if (exact.length === 1) {
    return exact[0] as string;
  }

  const contained = known.filter((candidate) => {
    const candidateLower = candidate.toLowerCase();
    return candidateLower.includes(lower) || lower.includes(candidateLower);
  });
  if (contained.length === 1) {
    return contained[0] as string;
  }

  const limit = key.length <= 4 ? 1 : 2;
  const closest: { key: string; distance: number }[] = [];
  for (const candidate of known) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance <= limit) {
      closest.push({ key: candidate, distance });
    }
  }
  if (closest.length === 0) {
    return null;
  }
  closest.sort((a, b) => a.distance - b.distance);
  const best = closest[0] as { key: string; distance: number };
  const tied = closest.filter((entry) => entry.distance === best.distance);
  return tied.length === 1 ? best.key : null;
}

/**
 * The keys in `bag` that nothing reads.
 *
 * `known` is the widget's own key list plus whatever the container owns; layout params and the base
 * widget options are always accepted. Keys with an `undefined` value are skipped, exactly like the
 * split itself does — `{ width: undefined }` is not a mistake.
 */
export function unknownOptionKeys(
  bag: Record<string, unknown>,
  known: readonly string[],
): string[] {
  const knownSet = new Set(known);
  const unknown: string[] = [];
  for (const key of Object.keys(bag)) {
    if (bag[key] === undefined) {
      continue;
    }
    if (knownSet.has(key) || LAYOUT_KEYS.has(key) || BASE_WIDGET_OPTION_KEYS.includes(key)) {
      continue;
    }
    unknown.push(key);
  }
  return unknown.sort();
}

/**
 * Reports the unknown keys of one option bag, once per distinct message.
 *
 * Called from `splitOptions`, so every widget and every plain container is covered by construction —
 * including the ones the DSL builds, because the DSL hands the same flat bag to the same constructor.
 */
export function reportUnknownOptions(bag: Record<string, unknown>, known: readonly string[]): void {
  if (!isDevMode()) {
    return;
  }
  const unknown = unknownOptionKeys(bag, known);
  if (unknown.length === 0) {
    return;
  }
  const allKnown = [
    ...known,
    ...(LAYOUT_PARAM_KEYS as readonly string[]),
    ...BASE_WIDGET_OPTION_KEYS,
  ];
  const name = typeof bag.name === 'string' && bag.name.length > 0 ? ` on "${bag.name}"` : '';
  for (const key of unknown) {
    const suggestion = suggestOptionKey(key, allKnown);
    warn(
      `unknown option "${key}"${name} — it is ignored.` +
        (suggestion === null ? '' : ` Did you mean "${suggestion}"?`),
    );
  }
}

/** Levenshtein distance, capped by the caller's threshold. */
function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const previous: number[] = new Array<number>(b.length + 1);
  const current: number[] = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) {
    previous[j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    for (let j = 0; j <= b.length; j++) {
      previous[j] = current[j] as number;
    }
  }
  return previous[b.length] as number;
}
