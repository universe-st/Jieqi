/**
 * `src/ai` — the opponent. Pure logic: no Phaser, no DOM, so it runs under plain Node in the tests and
 * inside a Web Worker or the main thread in the browser without changes.
 */

export {
  DIFFICULTY,
  analyse,
  chooseMove,
  chooseMoveAsync,
  type AiDecision,
  type AiOptions,
  type Difficulty,
  type DifficultyPreset,
  type ScoredMove,
} from './engine';
export { MATE, Searcher, type SearchLimits, type SearcherStats } from './search';
export { evaluate, evaluateFor } from './evaluate';
