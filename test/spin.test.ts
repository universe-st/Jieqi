/**
 * The draw that decides the player's colour.
 *
 * Two things have to be true and neither is visible in a screenshot: the landing must be **fair**, and
 * the face the animation stops on must be **the same face the game then hands the player**. The second
 * is the one that can silently break — the scene reads `plan.face`, so if the geometry ever disagreed
 * with the plan, the piece would settle on 帅 and the player would be given 黑.
 */

import { describe, expect, it } from 'vitest';

import {
  BACK_FACE,
  FIRST_MOVER,
  FRONT_FACE,
  MAX_HALF_TURNS,
  MIN_HALF_TURNS,
  SPIN_TOTAL_MS,
  faceAt,
  faceScale,
  planSpin,
  spinPhases,
} from '../src/core/spin';

/** A deterministic `random` that walks a fixed list of values, then repeats the last one. */
function scripted(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] as number;
}

describe('the spin geometry', () => {
  it('reads the front face at rest and the back face half a turn later', () => {
    expect(faceAt(0)).toBe(FRONT_FACE);
    expect(faceAt(Math.PI)).toBe(BACK_FACE);
    expect(faceAt(Math.PI * 2)).toBe(FRONT_FACE);
    expect(faceAt(-Math.PI)).toBe(BACK_FACE);
  });

  it('is edge-on at every quarter turn and face-on at every half turn', () => {
    for (let half = 0; half <= 8; half++) {
      expect(faceScale(Math.PI * half)).toBeCloseTo(1, 10);
      expect(faceScale(Math.PI * half + Math.PI / 2)).toBeCloseTo(0.07, 10);
    }
  });

  it('never lets the piece vanish, however it is sampled', () => {
    for (let i = 0; i < 3000; i++) {
      const radians = (i / 3000) * Math.PI * 20;
      expect(faceScale(radians)).toBeGreaterThanOrEqual(0.07);
      expect(faceScale(radians)).toBeLessThanOrEqual(1);
    }
  });
});

describe('planSpin', () => {
  it('lands on the face it announced, for both parities', () => {
    // First value picks the face, second the spin length: 0.1 → front, 0.9 → back.
    const front = planSpin(scripted([0.1, 0.9]));
    const back = planSpin(scripted([0.9, 0.0]));
    expect(front.face).toBe(FRONT_FACE);
    expect(back.face).toBe(BACK_FACE);
    // The whole point of the plan: the angle it stops at presents the planned face.
    expect(faceAt(front.radians)).toBe(front.face);
    expect(faceAt(back.radians)).toBe(back.face);
  });

  it('stops on the announced face for every combination of draws', () => {
    for (let a = 0; a < 20; a++) {
      for (let b = 0; b < 20; b++) {
        const plan = planSpin(scripted([a / 20 + 0.001, b / 20 + 0.001]));
        expect(faceAt(plan.radians)).toBe(plan.face);
      }
    }
  });

  it('always spins a readable number of half-turns', () => {
    for (let i = 0; i < 400; i++) {
      const plan = planSpin(scripted([i / 400, ((i * 7) % 100) / 100]));
      expect(plan.halfTurns).toBeGreaterThanOrEqual(MIN_HALF_TURNS);
      expect(plan.halfTurns).toBeLessThanOrEqual(MAX_HALF_TURNS);
      expect(plan.radians).toBeCloseTo(Math.PI * plan.halfTurns, 12);
      expect(plan.phases.totalMs).toBe(SPIN_TOTAL_MS);
      expect(plan.phases.glideMs).toBeGreaterThan(0);
      expect(plan.phases.settleMs).toBeGreaterThan(0);
    }
  });

  it('hands over from glide to landing without a jump in speed', () => {
    for (let halfTurns = MIN_HALF_TURNS; halfTurns <= MAX_HALF_TURNS; halfTurns++) {
      const { glideMs, settleMs } = spinPhases(halfTurns);
      // The glide turns (halfTurns - 1) half-turns at a constant rate; the settle's Cubic.easeOut
      // starts at three times its own average. Those two speeds must be the same number.
      const glideSpeed = (Math.PI * (halfTurns - 1)) / glideMs;
      const settleSpeed = (3 * Math.PI) / settleMs;
      expect(glideSpeed).toBeCloseTo(settleSpeed, 9);
    }
  });

  it('gives both faces to every spin length, so the duration never leaks the result', () => {
    // For each spin length there must be at least one front and one back draw — otherwise a long spin
    // would mean "black" and the animation would be a hint instead of a draw.
    const byLength = new Map<number, Set<string>>();
    for (let a = 0; a < 100; a++) {
      for (let b = 0; b < 100; b++) {
        const plan = planSpin(scripted([a / 100 + 0.001, b / 100 + 0.001]));
        const seen = byLength.get(plan.halfTurns) ?? new Set<string>();
        seen.add(plan.face);
        byLength.set(plan.halfTurns, seen);
      }
    }
    // Every reachable length is one parity, so pair them up: 6/7, 8/9, 10/11, 12/13.
    for (const [length, faces] of byLength) {
      const partner = byLength.get(length % 2 === 0 ? length + 1 : length - 1);
      expect(partner).toBeDefined();
      expect([...faces, ...(partner as Set<string>)]).toEqual(
        expect.arrayContaining([FRONT_FACE, BACK_FACE]),
      );
    }
  });

  it('is a fair draw', () => {
    const counts = { red: 0, black: 0 };
    const runs = 20_000;
    for (let i = 0; i < runs; i++) counts[planSpin().face] += 1;
    expect(counts.red + counts.black).toBe(runs);
    // 20k fair draws land within ~1.5% of half with overwhelming probability; 3% is a wide margin
    // that still catches a real bias (an off-by-one in the parity, a `<` flipped to `<=`).
    expect(Math.abs(counts.red / runs - 0.5)).toBeLessThan(0.03);
    expect(counts.red).toBeGreaterThan(0);
    expect(counts.black).toBeGreaterThan(0);
  });

  it('opens with red whoever won the draw (红先黑后)', () => {
    expect(FIRST_MOVER).toBe('red');
    expect(FRONT_FACE).toBe('red');
  });
});
