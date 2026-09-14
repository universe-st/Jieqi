import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The rules engine and the AI are deliberately Phaser-free and DOM-free, so the whole suite runs
    // in plain Node — that is the point of the `src/core` + `src/ai` layering rule.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The search tests play whole games against the clock; the default 5s is far too tight for them.
    testTimeout: 120_000,
  },
});
