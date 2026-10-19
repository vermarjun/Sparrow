/** Codex can return zero after its process is interrupted while a model turn is still active. */
export function codexExitWasInterrupted(code: number, screen: string): boolean {
  if (code !== 0) return false;
  const footer = screen.split('\n').filter((line) => line.trim()).slice(-6).join('\n');
  return /Working\s*\(/i.test(footer) || /esc to interrupt/i.test(footer);
}

