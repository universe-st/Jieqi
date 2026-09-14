/**
 * `Router` — the optional layer above the page stack: `this.mvvm.router` (PLAN M8).
 *
 * `pages.push(() => { … })` is already the whole mechanism, so what does a router add? Three things a
 * closure-per-navigation cannot give you:
 *
 * 1. **The views live in one place.** A table of `path → view` is data: it can be printed, listed in an
 *    error message, and changed without touching the call sites.
 * 2. **Navigation becomes a value.** `navigate('user/42')` is a string a test can assert, a log can
 *    record, and a debug page can display — instead of a closure that only exists at the call site.
 * 3. **A typo fails loudly.** An unknown path throws (in every build, not just development) with the
 *    table's keys in the message. Without the table, a wrong page name shows an empty screen.
 *
 * A route is a name plus params — deliberately **no URL routing**: nothing looks at `location`, and
 * there is no history the browser can drive. The page stack stays the single source of truth, so
 * `Esc`, a page's own "返回" button and `pages.pop()` all keep working and the router's view of the
 * stack stays correct (it annotates pages by id and drops annotations for pages that are gone).
 *
 * ```ts
 * this.mvvm.router.routes = {
 *   home: () => { Button('用户 42', { onClick: () => this.mvvm.router.navigate('user/42') }); },
 *   'user/:id': (params) => {
 *     const { id } = routeParams<{ id: string }>(params);
 *     Text(`用户 ${id}`);
 *   },
 * };
 * ```
 *
 * What it does **not** do: page transitions (nothing here animates), caching, deep links, guards, or
 * replacing the base page — `replace()` swaps the top page and pushes when only the base one is left
 * (popping the base would leave an empty screen; `PageHost` refuses it).
 */

import { devLog, isDevMode } from '@phaser-mvvm/core';
import type { PageHandle, PageOptions } from './pages';
import {
  UnknownRouteError,
  matchRoute,
  normalizeRoutePath,
  routeNames,
  type RouteBuilder,
  type RouteParams,
  type RouteTable,
} from './route-plan';

/** One entry of the router's history: where a page came from. */
export interface RouteVisit {
  /** The key that matched (`'user/:id'`), which is what identifies the *route* rather than the visit. */
  readonly key: string;
  /** The path as asked for, normalised (`'user/42'`). */
  readonly path: string;
  /** Path captures merged with what the caller passed to `navigate()`. */
  readonly params: RouteParams;
}

/** Per-navigation options: everything `pages.push()` takes, minus the name the router owns. */
export type RouteOptions = Omit<PageOptions, 'name'>;

/**
 * The slice of `PageHost` the router uses.
 *
 * Structural on purpose: `Router` then needs no Phaser and no scene, so its bookkeeping — which page
 * came from which route, what `current` says after a page is popped by someone else, and when a visit
 * is forgotten — is unit-tested in Node against a fake stack (`test/router.test.ts`).
 */
export interface RouterPageStack {
  readonly depth: number;
  readonly top: PageHandle | null;
  readonly handles: readonly PageHandle[];
  push(content: () => void, options?: PageOptions): PageHandle;
  pop(): boolean;
}

/** What the router needs from its host: the page stack, and nothing else. */
export interface RouterHost {
  readonly pages: RouterPageStack;
}

export class Router {
  private readonly plugin: RouterHost;
  private table: RouteTable = {};
  /**
   * The route each page came from, keyed by page id.
   *
   * Keyed by id and not "the last N navigations", so a page popped by `Esc`, by its own button or by
   * `popToRoot()` simply stops being found — the router never has to be told about a pop, which is what
   * keeps it honest when the app navigates without it.
   */
  private readonly visits = new Map<number, RouteVisit>();

  constructor(plugin: RouterHost) {
    this.plugin = plugin;
  }

  /** The route table. Assign a whole table, or add one route with `route()`. */
  get routes(): RouteTable {
    return this.table;
  }

  set routes(table: RouteTable) {
    this.table = table;
  }

  /** Registers one route, keeping the rest of the table. */
  route(path: string, builder: RouteBuilder): this {
    this.table = { ...this.table, [path]: builder };
    return this;
  }

  /** Pushes the page for `path`, so `back` (Escape, a "返回" button) returns to the current page. */
  navigate(path: string, params?: RouteParams, options?: RouteOptions): PageHandle {
    return this.open(path, params, options, false);
  }

  /**
   * Swaps the top page for the page of `path`.
   *
   * With only the base page left, `navigate()` semantics apply instead (the base page cannot be popped
   * — see `PageHost`) and the target is pushed on top of it.
   */
  replace(path: string, params?: RouteParams, options?: RouteOptions): PageHandle {
    return this.open(path, params, options, true);
  }

  /** Pops the top page. `false` when only the base page is left (the app's own `back` decides). */
  back(): boolean {
    const popped = this.plugin.pages.pop();
    this.prune();
    return popped;
  }

  /** Where the visible page came from, or `null` when it was not opened through the router. */
  get current(): RouteVisit | null {
    this.prune();
    const top = this.plugin.pages.top;
    if (!top) {
      return null;
    }
    return this.visits.get(top.id) ?? null;
  }

  /** The route of every page on the stack, bottom to top (pages opened directly are skipped). */
  get history(): readonly RouteVisit[] {
    this.prune();
    const handles = this.plugin.pages.handles;
    const visits: RouteVisit[] = [];
    for (const handle of handles) {
      const visit = this.visits.get(handle.id);
      if (visit) {
        visits.push(visit);
      }
    }
    return visits;
  }

  /** Number of pages on the stack (routed or not). */
  get depth(): number {
    return this.plugin.pages.depth;
  }

  /** Drops the routing bookkeeping (scene teardown; the pages are destroyed with the UI root). */
  dispose(): void {
    this.visits.clear();
  }

  /**
   * Forgets visits whose page is gone.
   *
   * Called on every navigation and on every read, so the map cannot grow with `navigate`/`back` cycles
   * even in an app that never looks at `history` (a churn of a thousand round trips used to leave a
   * thousand dead entries behind — found while writing the fake-stack tests).
   */
  private prune(): void {
    if (this.visits.size === 0) {
      return;
    }
    const live = new Set(this.plugin.pages.handles.map((handle) => handle.id));
    for (const id of [...this.visits.keys()]) {
      if (!live.has(id)) {
        this.visits.delete(id);
      }
    }
  }

  private open(
    path: string,
    params: RouteParams | undefined,
    options: RouteOptions | undefined,
    replace: boolean,
  ): PageHandle {
    const match = matchRoute(this.table, path, params);
    if (!match) {
      // Thrown in every build: a navigation that goes nowhere is a bug in the app, not a rendering
      // detail, and an empty screen with a console line is much harder to find than an exception with
      // the table in it.
      throw new UnknownRouteError(normalizeRoutePath(path), routeNames(this.table));
    }
    const builder = this.table[match.key];
    if (!builder) {
      throw new UnknownRouteError(normalizeRoutePath(path), routeNames(this.table));
    }

    if (replace) {
      this.back();
    }
    const visit: RouteVisit = {
      key: match.key,
      path: normalizeRoutePath(path),
      params: match.params,
    };
    const page = this.plugin.pages.push(() => builder(visit.params), {
      ...options,
      name: `route:${visit.path}`,
    });
    this.visits.set(page.id, visit);
    this.prune();

    if (isDevMode()) {
      devLog(
        `router.${replace ? 'replace' : 'navigate'}: ${visit.path} (key ${visit.key}, depth ${this.depth})`,
      );
    }
    return page;
  }
}
