/**
 * Deterministic pseudo-random numbers.
 *
 * Everything random in this game — the deal, the AI's world sampling, its tie-breaking noise — goes
 * through a {@link Rng} that the app creates from an explicit seed. That is what makes an acceptance
 * run reproducible: `__JIEQI__.newGame(12345)` always deals the same board and always produces the
 * same AI replies.
 */

export interface Rng {
  /** Uniform in `[0, 1)`. */
  next(): number;
  /** Uniform integer in `[0, n)`. */
  int(n: number): number;
  /** Fisher–Yates shuffle, in place. */
  shuffle<T>(items: T[]): T[];
  /** The seed this generator was created from. */
  readonly seed: number;
}

/** mulberry32 — small, fast, and good enough for a board game's shuffling and tie-breaking. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (n: number): number => Math.floor(next() * n);

  const shuffle = <T>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const a = items[i] as T;
      const b = items[j] as T;
      items[i] = b;
      items[j] = a;
    }
    return items;
  };

  return { next, int, shuffle, seed: seed >>> 0 };
}

/** A seed for "just give me a new game", for callers that do not care about reproducibility. */
export function randomSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) ^ Date.now()) >>> 0;
}
