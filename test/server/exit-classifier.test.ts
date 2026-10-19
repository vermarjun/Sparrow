import { describe, expect, test } from 'bun:test';
import { codexExitWasInterrupted } from '../../src/server/exit-classifier';

describe('Codex zero-exit classifier', () => {
  test('recognizes a live work footer from the last captured screen', () => {
    expect(codexExitWasInterrupted(0, 'transcript\n• Working (7m 19s · esc to interrupt)')).toBe(true);
    expect(codexExitWasInterrupted(0, 'transcript\nesc to interrupt · ctrl+c to exit')).toBe(true);
  });

  test('does not treat clean idle screens, old transcript text, or nonzero exits as zero-exit interruptions', () => {
    expect(codexExitWasInterrupted(0, 'old transcript says Working (7m)\n›\nready 1\nready 2\nready 3\nready 4\nready 5\nready 6')).toBe(false);
    expect(codexExitWasInterrupted(0, '›\n\nReady')).toBe(false);
    expect(codexExitWasInterrupted(143, 'Working (7m 19s)\nesc to interrupt')).toBe(false);
  });
});
