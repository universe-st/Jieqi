/**
 * Pointer drag claims: the small protocol that lets one widget say "this press is mine" before a
 * `ScrollView` decides to scroll with it.
 *
 * The problem it solves is ordering. A drag starts on a `pointerdown` that *two* listeners want: the
 * widget under the pointer (a `TextField` placing its caret) and every enclosing `ScrollView` (which
 * arms a scroll drag immediately and only commits once the pointer has travelled past a threshold).
 * Whether the widget sees the event first is not something either side should have to know, so the
 * widget **claims** the pointer from its own handler and the scroll view **asks** — at the moment it
 * actually wants to move — whether somebody else owns it:
 *
 * - the field claims on `pointerdown`, so a `ScrollView` whose handler ran first still sees the claim
 *   by the time the threshold is crossed and hands the gesture over;
 * - a press that nobody claimed behaves exactly as before (the port scrolls).
 *
 * Claims are keyed by scene and pointer id, so two scenes cannot see each other's drags, and a
 * multi-touch gesture keeps its two fingers apart (`ScrollView`'s pinch still works: a text field only
 * ever claims the pointer that pressed *it*).
 *
 * `release()` is the caller's job on `pointerup`/`pointerupoutside` — an owner that keeps a claim
 * while nothing is pressed refuses every later drag, which is the V24 shape of defect. `clear()` runs
 * on scene shutdown so nothing survives a restart.
 */

/** Anything that can own a drag; only used for dev logs, hence the loose type. */
export interface PointerClaimOwner {
  /** Used in the dev log; falls back to the constructor name. */
  readonly name?: string;
}

const claims = new WeakMap<object, Map<number, PointerClaimOwner>>();

/** The map for a scene, created on first use. `null` when there is no scene to key on. */
function claimsOf(scene: object | null | undefined): Map<number, PointerClaimOwner> | null {
  if (!scene || typeof scene !== 'object') {
    return null;
  }
  let map = claims.get(scene);
  if (map === undefined) {
    map = new Map();
    claims.set(scene, map);
  }
  return map;
}

/** Claims the drag of `pointerId` for `owner`. A later claim replaces an earlier one (last wins). */
export function claimPointerDrag(
  scene: object | null | undefined,
  pointerId: number,
  owner: PointerClaimOwner,
): void {
  if (!Number.isFinite(pointerId)) {
    return;
  }
  claimsOf(scene)?.set(pointerId, owner);
}

/**
 * The owner of a pointer's drag, or `null` when it is free.
 *
 * `except` ignores that owner's own claim, which is what a widget asks when it wants to know whether
 * *somebody else* took the gesture.
 */
export function pointerDragOwner(
  scene: object | null | undefined,
  pointerId: number,
  except?: PointerClaimOwner,
): PointerClaimOwner | null {
  const owner = claimsOf(scene)?.get(pointerId) ?? null;
  return owner === except ? null : owner;
}

/**
 * Releases a claim.
 *
 * With `owner` the release only happens when the claim is still that owner's, so a stale `pointerup`
 * from a previous gesture cannot drop the claim a new one just made.
 */
export function releasePointerDrag(
  scene: object | null | undefined,
  pointerId: number,
  owner?: PointerClaimOwner,
): void {
  const map = claimsOf(scene);
  if (map === null) {
    return;
  }
  if (owner !== undefined && map.get(pointerId) !== owner) {
    return;
  }
  map.delete(pointerId);
}

/** Drops every claim of a scene (scene shutdown / restart). */
export function clearPointerClaims(scene: object | null | undefined): void {
  if (scene && typeof scene === 'object') {
    claims.delete(scene);
  }
}

/** Every outstanding claim of a scene, for a probe or a dev log. */
export function pointerClaims(
  scene: object | null | undefined,
): Array<{ pointerId: number; owner: string }> {
  const map = claimsOf(scene);
  if (map === null) {
    return [];
  }
  return [...map].map(([pointerId, owner]) => ({
    pointerId,
    owner: owner.name ?? owner.constructor?.name ?? 'anonymous',
  }));
}
