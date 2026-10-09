import { TEST_HOME, tempDir, until } from './helpers';
import { afterAll, describe, expect, test } from 'bun:test';
import * as tmux from '../../src/harness/tmux';
import { sq } from '../../src/harness/launch';

afterAll(async () => {
  await tmux.killServer();
});

describe('tmux wrapper (private socket)', () => {
  test('uses -L <socket> and never the default server', () => {
    expect(tmux.tmuxArgv(['ls'])).toEqual(['tmux', '-L', process.env.SPARROW_TMUX_SOCKET!, 'ls']);
  });

  test('newWindow creates the session with the window as its first window; ids, names, cwd', async () => {
    const cwd = tempDir("dir with spaces 'q'");
    const id = await tmux.newWindow({ session: 'sptest-tm-1', name: 'alpha', cwd, command: 'sleep 30' });
    expect(id).toMatch(/^@\d+$/);
    const r = await tmux.tmux(['list-windows', '-t', '=sptest-tm-1', '-F', '#{window_id} #{window_name} #{pane_current_path}']);
    const lines = r.stdout.trim().split('\n');
    expect(lines.length).toBe(1); // no stray shell window
    expect(lines[0]).toBe(`${id} alpha ${cwd}`);
    // second window in the existing session
    const id2 = await tmux.newWindow({ session: 'sptest-tm-1', name: 'beta', cwd, command: 'sleep 30' });
    expect(id2).not.toBe(id);
    expect(await tmux.windowAlive(id2)).toBe(true);
    await tmux.killWindow(id2);
    expect(await tmux.windowAlive(id2)).toBe(false);
    await tmux.killWindow(id2); // idempotent
    await tmux.killWindow(id);
  });

  test('session names with a common prefix are matched exactly', async () => {
    const cwd = tempDir('px');
    const a = await tmux.newWindow({ session: 'sptest-px-long', name: 'a', cwd, command: 'sleep 30' });
    expect(await tmux.hasSession('sptest-px')).toBe(false);
    const b = await tmux.newWindow({ session: 'sptest-px', name: 'b', cwd, command: 'sleep 30' });
    const r = await tmux.tmux(['list-windows', '-t', '=sptest-px', '-F', '#{window_id}']);
    expect(r.stdout.trim()).toBe(b);
    await tmux.killWindow(a);
    await tmux.killWindow(b);
  });

  test('windowAlive is false when the pane process died (remain-on-exit)', async () => {
    const cwd = tempDir('dead');
    const id = await tmux.newWindow({ session: 'sptest-tm-2', name: 'd', cwd, command: 'sleep 30' });
    await tmux.tmux(['set-option', '-w', '-t', id, 'remain-on-exit', 'on']);
    expect(await tmux.windowAlive(id)).toBe(true);
    const pid = await tmux.panePid(id);
    process.kill(pid!, 'SIGKILL');
    await until(async () => !(await tmux.windowAlive(id)), 5000);
    expect(await tmux.windowExists(id)).toBe(true); // window still there, pane dead
    await tmux.killWindow(id);
    expect(await tmux.windowExists(id)).toBe(false);
  });

  test('capture strips ANSI and returns scrollback; paste is bracketed and keeps lines together', async () => {
    const cwd = tempDir('cap');
    const script = `${TEST_HOME}/cat.sh`;
    await Bun.write(script, `printf '\\033[31mRED\\033[0m plain\\n'; printf '\\033[?2004h'; stty raw -echo; exec cat -v`);
    const id = await tmux.newWindow({ session: 'sptest-tm-3', name: 'c', cwd, command: `bash ${sq(script)}` });
    await until(async () => (await tmux.capture(id)).includes('RED plain'), 5000);
    const text = await tmux.capture(id, 50);
    expect(text).toContain('RED plain');
    expect(text).not.toContain('\x1b');
    await tmux.paste(id, 'one\ntwo');
    // cat -v shows ESC as ^[ — the paste is wrapped in ^[[200~ … ^[[201~ and LF became CR (^M)
    await until(async () => (await tmux.capture(id)).includes('^[[201~'), 5000);
    const after = await tmux.capture(id);
    expect(after).toContain('^[[200~one^Mtwo^[[201~');
    await tmux.killWindow(id);
  });

  test('stripAnsi', () => {
    expect(tmux.stripAnsi('\x1b[1;32mok\x1b[0m \x1b]0;title\x07x')).toBe('ok x');
  });
});
