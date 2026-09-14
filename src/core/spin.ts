/**
 * 定先后 — the draw that decides which side the player takes.
 *
 * One piece spins about its vertical axis: the front face is 红帅, the back face is 黑将, and where it
 * stops is the colour the player plays. The whole thing is *geometry*, so it lives here — Phaser-free
 * and DOM-free like the rest of `src/core` — and the scene only has to turn an angle into a scale.
 *
 * The model is a coin seen from the front. Let `θ` be how far the piece has turned:
 *
 * - `cos θ > 0` → the front (帅, red) faces the player,
 * - `cos θ < 0` → the back (将, black) does,
 * - `|cos θ|` → how wide the piece looks, 1 face-on and 0 edge-on.
 *
 * So "which face did it land on?" is one comparison, and "did it land fairly?" is one parity check:
 * an even number of half-turns is the front, an odd number is the back. Choosing the parity from a
 * random draw and the *number of turns* from another is what makes the outcome look like a spin rather
 * than like a two-frame flip — see {@link planSpin}.
 */

import { FIRST_MOVER, type Color } from './types';

/** The face that means 红 (帅) and the face that means 黑 (将); the draw hands back a `Color`. */
export { FIRST_MOVER };
export const FRONT_FACE: Color = FIRST_MOVER;
export const BACK_FACE: Color = 'black';

/** Which face of the piece a rotation of `radians` presents. */
export function faceAt(radians: number): Color {
  return Math.cos(radians) >= 0 ? FRONT_FACE : BACK_FACE;
}

/**
 * The horizontal squash of a piece turned by `radians`.
 *
 * Clamped so a piece is never infinitely thin — a one-pixel line reads as "the piece disappeared",
 * which is exactly the frame the eye is most likely to catch.
 */
export function faceScale(radians: number, min = 0.07): number {
  return Math.max(min, Math.abs(Math.cos(radians)));
}

/** Shortest spin, in half-turns — six is already more than the eye can count. */
export const MIN_HALF_TURNS = 6;
/** How many *whole* extra rotations a spin may be lengthened by. */
export const SPIN_LENGTH_STEPS = 4;
/** Longest spin: the short one plus every extra rotation, and the odd half-turn that lands on 将. */
export const MAX_HALF_TURNS = MIN_HALF_TURNS + (SPIN_LENGTH_STEPS - 1) * 2 + 1;

/** How long every spin lasts, whatever its length. The draw is not a race. */
export const SPIN_TOTAL_MS = 2400;

/**
 * How fast the last half-turn starts, relative to the average speed of the turns before it.
 *
 * The final half-turn is the one the player actually watches — it is where 帅 becomes 将 — so it gets a
 * decelerating ease while everything before it runs at a constant speed. `Cubic.easeOut` leaves its
 * ease at three times its own average, so matching the two speeds needs exactly this factor; get it
 * wrong and the piece visibly jumps at the hand-over.
 */
const SETTLE_ENTRY_SPEED = 3;

export interface SpinPhases {
  /** The constant-speed turns: `halfTurns - 1` of them, at a steady rate — "it keeps spinning". */
  readonly glideMs: number;
  /** The last half-turn, decelerating into the landing. */
  readonly settleMs: number;
  readonly totalMs: number;
}

/**
 * Splits the spin into a constant-speed glide and a decelerating landing.
 *
 * `settleMs = 3 · glideMs / (halfTurns − 1)` is what makes the hand-over between the two seamless: the
 * glide's angular speed is `π(halfTurns−1)/glideMs` and the settle's *initial* speed is `3π/settleMs`,
 * and the equation is those two being equal. The pair is then scaled so the total stays
 * {@link SPIN_TOTAL_MS}, which is why a longer spin does not take longer — it just spins faster.
 */
export function spinPhases(halfTurns: number): SpinPhases {
  const turns = Math.max(2, halfTurns);
  const glideMs = SPIN_TOTAL_MS / (1 + SETTLE_ENTRY_SPEED / (turns - 1));
  return { glideMs, settleMs: SPIN_TOTAL_MS - glideMs, totalMs: SPIN_TOTAL_MS };
}

export interface SpinPlan {
  /** The face that ends up showing — and therefore the colour the player plays. */
  readonly face: Color;
  /** How many half-turns the piece makes. Odd lands on the back (将), even on the front (帅). */
  readonly halfTurns: number;
  /** {@link halfTurns} as an angle, which is what the animation runs on. */
  readonly radians: number;
  /** How that angle is spread over time. */
  readonly phases: SpinPhases;
}

/**
 * Draws an outcome and dresses it up as a spin.
 *
 * Two independent random numbers, deliberately: the first decides **where it stops** (a fair 50/50 the
 * player can read as luck) and the second **how far it travels to get there**, rounded to whole
 * rotations so it can only ever add turns, never change the face. Keeping them apart is what stops the
 * spin length from leaking the result — every spin length is reachable from both faces.
 */
export function planSpin(random: () => number = Math.random): SpinPlan {
  const face: Color = random() < 0.5 ? FRONT_FACE : BACK_FACE;
  const extraTurns = Math.floor(random() * SPIN_LENGTH_STEPS) * 2;
  const halfTurns = MIN_HALF_TURNS + extraTurns + (face === BACK_FACE ? 1 : 0);
  return {
    face,
    halfTurns,
    radians: Math.PI * halfTurns,
    phases: spinPhases(halfTurns),
  };
}

/** 你执红 · 先行 / 你执黑 · 后行 — the line the draw scene shows once the piece stops. */
export function drawVerdict(face: Color): { title: string; detail: string } {
  const red = face === FRONT_FACE;
  return {
    title: red ? '红 帅' : '黑 将',
    detail: red ? '你执红方 · 先行' : '你执黑方 · 电脑先行',
  };
}
