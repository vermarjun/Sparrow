import { expect, test } from 'bun:test';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnv, REPO } from './helpers';

function fakeAgents(tag: string): { pid: number; command: string }[] {
  const result = Bun.spawnSync(['ps', '-ww', '-Ao', 'pid=,command='], { stdout: 'pipe', stderr: 'ignore' });
  return result.stdout.toString().split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || !match[2].includes(join(REPO, 'src', 'harness', 'fake-agent.ts')) || !match[2].includes(tag)) return [];
    return [{ pid: Number(match[1]), command: match[2] }];
  });
}

test('D8 lifecycle suite leaves no fake agents on its owned tmux server', async () => {
  const tag = `dogfood-d8-${process.pid}`;
  const lifecycle = join(REPO, 'test', 'cli', 'lifecycle.test.ts');
  const isolatedTest = join(REPO, 'test', 'cli', `lifecycle-${tag}.test.ts`);
  const original = readFileSync(lifecycle, 'utf8');
  const isolated = original
    .replace(/const SOCKET = .*;\nconst PREFIX = .*;/, `const SOCKET = '${tag}';\nconst PREFIX = '${tag}-';`)
    .replaceAll('u1cli', tag);
  writeFileSync(isolatedTest, isolated);
  const before = new Set(fakeAgents(tag).map((p) => p.pid));
  const proc = Bun.spawn([process.execPath, 'test', isolatedTest], {
    cwd: REPO,
    env: cleanEnv({
      SPARROW_HOME: join(REPO, '.sandbox', `${tag}-home`),
      SPARROW_PORT: '4598',
      SPARROW_TMUX_SOCKET: tag,
      SPARROW_TMUX_PREFIX: `${tag}-`,
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    output = `${stdout}${stderr}`;
    expect(code).toBe(0);
    expect(output).toMatch(/Ran \d+ tests across 1 file\./);
    const leaked = fakeAgents(tag).filter((p) => !before.has(p.pid));
    expect(leaked).toEqual([]);
  } finally {
    Bun.spawnSync(['tmux', '-L', tag, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' });
    for (let i = 0; i < 40 && fakeAgents(tag).some((p) => !before.has(p.pid)); i++) await Bun.sleep(50);
    for (const p of fakeAgents(tag)) {
      if (before.has(p.pid)) continue;
      try { process.kill(p.pid, 'SIGTERM'); } catch {}
    }
    try { unlinkSync(isolatedTest); } catch {}
  }
}, 30_000);
