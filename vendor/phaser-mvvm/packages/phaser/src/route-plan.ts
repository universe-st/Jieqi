/**
 * Route matching: the pure half of `this.mvvm.router` (PLAN M8's lightweight `Router`).
 *
 * A route table is a plain object — `{ 'user/:id': (params) => { … } }` — and this module answers the
 * only hard question it raises: **which key matches a path, and what are its parameters?** Keeping that
 * here (no Phaser, not even a type import) means the precedence rules are unit-tested in Node instead of
 * being inferred from whatever a browser run happened to do.
 *
 * The rules, in order, because a table can be ambiguous:
 *
 * 1. **Exact key wins.** A table with both `'user/me'` and `'user/:id'` sends `'user/me'` to the literal
 *    entry, and only then tries patterns — the same "most specific first" instinct a reader has.
 * 2. **Patterns match in declaration order.** Two patterns that both match (`'user/:id'` and `':area/:id'`)
 *    resolve to the first one declared, so the table reads top-to-bottom.
 * 3. **Own properties only.** Lookups go through `hasOwnProperty`, so `navigate('constructor')` is an
 *    unknown route rather than a call into `Object.prototype` (the same guard `planBranch` uses).
 *
 * Not supported on purpose: wildcards/splats, optional segments, typed params and query-string parsing.
 * A route is a name plus string params; anything richer belongs in the app.
 */

/** Parameters of a route: path captures plus whatever the caller passed to `navigate()`. */
export type RouteParams = Readonly<Record<string, string>>;

/** A route's view: the same lambda `ui()`/`pages.push()` take, with the route's params. */
export type RouteBuilder = (params: RouteParams) => void;

/** A route table: path (or pattern) → view builder. */
export type RouteTable = Readonly<Record<string, RouteBuilder>>;

/** What a path resolved to. */
export interface RouteMatch {
  /** The table key that matched — a literal name, or the pattern (`'user/:id'`). */
  readonly key: string;
  /** Captured path params, with any explicitly passed params merged over them. */
  readonly params: RouteParams;
}

const hasOwn = (table: RouteTable, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(table, key);

/**
 * Normalises a path for matching: `'#/user/42/'` and `'user//42'` both become `'user/42'`.
 *
 * The router does not do URL routing, but a path is still what a caller types, and being strict about
 * exactly one spelling would only produce "the route exists but nothing matched" reports.
 */
export function normalizeRoutePath(path: string): string {
  return path
    .trim()
    .replace(/^#/, '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');
}

function splitSegments(path: string): string[] {
  return path.length === 0 ? [] : path.split('/');
}

/**
 * Finds the route `path` refers to.
 *
 * @returns the matching key and its params, or `null` when nothing matches (the caller decides whether
 * that is an error — the `Router` throws a named one listing the table).
 */
export function matchRoute(
  table: RouteTable,
  path: string,
  extra?: RouteParams,
): RouteMatch | null {
  const normalized = normalizeRoutePath(path);
  if (hasOwn(table, normalized)) {
    return { key: normalized, params: freeze({ ...extra }) };
  }

  const segments = splitSegments(normalized);
  for (const key of Object.keys(table)) {
    const pattern = splitSegments(key);
    if (pattern.length !== segments.length) {
      continue;
    }
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < pattern.length; i++) {
      const part = pattern[i] ?? '';
      const value = segments[i] ?? '';
      if (part.startsWith(':')) {
        const name = part.slice(1);
        if (name.length === 0 || value.length === 0) {
          matched = false;
          break;
        }
        params[name] = decodeURIComponent(value);
        continue;
      }
      if (part !== value) {
        matched = false;
        break;
      }
    }
    if (matched) {
      // Explicit params win: they are the caller's intent for *this* visit, while a path capture is
      // whatever happened to be in the path.
      return { key, params: freeze({ ...params, ...extra }) };
    }
  }
  return null;
}

/** The table's keys, in declaration order — what an "unknown route" message lists. */
export function routeNames(table: RouteTable): string[] {
  return Object.keys(table);
}

/**
 * Reads a route's params with the keys its pattern declared.
 *
 * A path param is never missing at runtime — the matcher only calls a builder whose pattern matched —
 * so this is a documented cast, not a check: it exists because TypeScript cannot know that
 * `RouteParams['id']` is present (`noUncheckedIndexedAccess` makes every index read optional).
 *
 * ```ts
 * 'user/:id': (params) => {
 *   const { id } = routeParams<{ id: string }>(params);
 *   Text(`用户 ${id}`);
 * }
 * ```
 */
export function routeParams<T extends RouteParams>(params: RouteParams): T {
  return params as T;
}

/** Thrown by `Router#navigate` for a path the table does not know. */
export class UnknownRouteError extends Error {
  constructor(
    readonly path: string,
    readonly known: readonly string[],
  ) {
    super(
      `Unknown route "${path}" — the table has: ${
        known.length > 0 ? known.join(', ') : '(empty)'
      }. Add it to \`this.mvvm.router.routes\`, or check the spelling.`,
    );
    this.name = 'UnknownRouteError';
  }
}

/** Params are handed to view lambdas and stored on visits; a shared frozen object keeps them read-only. */
function freeze(params: Record<string, string>): RouteParams {
  return Object.freeze(params);
}
