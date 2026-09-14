/**
 * Who owns a `back` action (Escape / gamepad B) — the whole rule in one pure function.
 *
 * It lives in its own module, free of Phaser imports, because it is *the* routing decision of the
 * framework and was previously buried in `MVVMPlugin.handleBack()` where only a browser could check
 * it. `packages/phaser/test/plan-back.test.ts` covers the boundaries:
 *
 * 1. **a modal owns it first** — including the case where it is deliberately not dismissible, which
 *    *swallows* the action rather than letting the page below act on a question that must be answered;
 * 2. **then the page stack**, but only while there is a page to go back *to*: popping the base page
 *    would leave an empty screen, so a single-page app falls through;
 * 3. **then the app** (`config.onBack` / `focus.onBack`).
 */

/** Which layer should handle a `back` action. */
export type PageBackTarget = 'modal' | 'page' | 'app';

/** The state the decision depends on: how deep each stack is. */
export interface BackState {
  /** Open modals; the top one decides (a non-dismissible one swallows the action). */
  modalDepth: number;
  /** Pages on the stack; `1` means "the base page only", which cannot be popped. */
  pageDepth: number;
}

/** Resolves the owner of a `back` action; see the module comment for the order. */
export function planBack(state: BackState): PageBackTarget {
  if (state.modalDepth > 0) {
    return 'modal';
  }
  return state.pageDepth > 1 ? 'page' : 'app';
}
