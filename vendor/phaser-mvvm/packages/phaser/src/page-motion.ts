/**
 * Page transitions: what to animate when the page stack moves (PLAN M8's 页面转场).
 *
 * A page in this framework is a whole view under the UI root, and pushing one used to be an instant
 * swap: the old page is hidden the moment the new one exists. The transition is therefore a **cross
 * fade between two pages that are both on screen** — the page underneath keeps its pixels (it is still
 * visible) but loses its routing (`Widget#routingEnabled = false`), so a click during the 160 ms cannot
 * land on a page the user has already left. That is the whole trick, and it is why `pages.ts` needs no
 * ghost bookkeeping beyond "finish what was in flight".
 *
 * Why alpha only: a slide would have to move `widget.x`, and the layout pass owns that field — the
 * arrange pass would put it back on the next layout of that subtree (`flushLayout` runs *before* the
 * transition step, so it usually survives the frame, but "usually" is not a guarantee worth shipping
 * for a 20 px slide). Scale is out for the same reason the modal only scales its content: a full-stage
 * layer that shrinks towards its top-left corner reads as the whole stage moving.
 *
 * The rules are pure functions so the browser run only has to confirm them.
 */

import type { ResolvedTransition, ResolvedTransitions } from './transition';

/** Which way the stack moved. */
export type PageDirection = 'forward' | 'back';

/** What one stack move animates. */
export interface PageMotionPlan {
  /**
   * The page that is now on top (a push) — `null` when a push is not animated, or when the stack moved
   * backwards (nothing has to fade in: the revealed page is simply there).
   */
  incoming: ResolvedTransition | null;
  /**
   * The page that is leaving (a pop) — it stays painted (with routing off) until this run ends, and is
   * destroyed then. `null` for a forward move: the page underneath a push is *not* animated, it just
   * stops being routed and is hidden once the cross fade is over.
   */
  outgoing: ResolvedTransition | null;
  /**
   * Whether the page below has to stay painted during the move — `true` for both directions, because
   * the cross fade needs something to fade *over*. When every duration is 0 the caller takes the
   * instant path instead and this is ignored.
   */
  keepNeighbourPainted: boolean;
}

/** Alpha-only version of a resolved transition: the property set a full-page layer may animate. */
function alphaOnly(transition: ResolvedTransition): ResolvedTransition {
  return { ...transition, scale: null };
}

/**
 * Decides what a stack move animates.
 *
 * A zero-length `enter`/`exit` (a `prefers-reduced-motion` page, `transition: false`, or a per-page
 * override) collapses to `null`, which is the caller's signal to take the synchronous path it took
 * before this existed.
 */
export function planPageMotion(
  direction: PageDirection,
  policy: ResolvedTransitions,
): PageMotionPlan {
  const enter = policy.enter.duration > 0 ? alphaOnly(policy.enter) : null;
  const exit = policy.exit.duration > 0 ? alphaOnly(policy.exit) : null;
  if (direction === 'forward') {
    return { incoming: enter, outgoing: null, keepNeighbourPainted: enter !== null };
  }
  return { incoming: null, outgoing: exit, keepNeighbourPainted: exit !== null };
}
