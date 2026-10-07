// Thin wrapper over the tmux CLI. Honours SPARROW_TMUX_SOCKET (tmux -L <socket>) so tests run on a
// private tmux server and never touch the user's sessions.
import { tmuxSocket } from './env';

export interface TmuxResult { code: number; stdout: string; stderr: string }

export function tmuxArgv(args: string[]): string[] {
  const sock = tmuxSocket();
  return sock ? ['tmux', '-L', sock, ...args] : ['tmux', ...args];
}

export async function tmux(args: string[], opts: { stdin?: string; check?: boolean } = {}): Promise<TmuxResult> {
  const proc = Bun.spawn(tmuxArgv(args), {
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // Don't let a TMUX var from the calling shell redirect us to another server.
    env: { ...process.env, TMUX: '' },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (opts.check !== false && code !== 0) {
    throw new Error(`tmux ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
  }
  return { code, stdout, stderr };
}

export async function hasSession(session: string): Promise<boolean> {
  // '=' prefix = exact match (no prefix matching of session names)
  const r = await tmux(['has-session', '-t', `=${session}`], { check: false });
  return r.code === 0;
}

export async function ensureSession(session: string, cwd: string): Promise<void> {
  if (await hasSession(session)) return;
  const r = await tmux(['new-session', '-d', '-s', session, '-c', cwd, '-x', '220', '-y', '50'], { check: false });
  // Lost a race with another start: fine as long as it exists now.
  if (r.code !== 0 && !(await hasSession(session))) {
    throw new Error(`tmux new-session ${session} failed: ${r.stderr.trim()}`);
  }
}

export interface NewWindowOpts {
  session: string;
  name: string;
  cwd: string;
  command: string; // a single shell command string run by tmux (e.g. "bash '/path/script.sh'")
}

// Creates a detached window at the end of the session; returns its id ('@17').
// When the session does not exist yet it is created with this window as its first window (no stray shell).
export async function newWindow(o: NewWindowOpts): Promise<string> {
  let r: TmuxResult | null = null;
  if (!(await hasSession(o.session))) {
    r = await tmux([
      'new-session', '-d', '-P', '-F', '#{window_id}', '-s', o.session, '-n', o.name, '-c', o.cwd,
      '-x', '220', '-y', '50', o.command,
    ], { check: false });
    if (r.code !== 0) r = null; // lost a race: someone created it; add a window below
  }
  if (!r) {
    r = await tmux([
      'new-window', '-d', '-P', '-F', '#{window_id}',
      '-t', `=${o.session}:`, '-n', o.name, '-c', o.cwd, o.command,
    ]);
  }
  const id = r.stdout.trim();
  if (!/^@\d+$/.test(id)) throw new Error(`tmux new-window returned unexpected id: ${JSON.stringify(id)}`);
  // Keep the name we gave it (TUIs set titles; automatic-rename would rename the window).
  await tmux(['set-option', '-w', '-t', id, 'automatic-rename', 'off'], { check: false });
  await tmux(['set-option', '-w', '-t', id, 'allow-rename', 'off'], { check: false });
  return id;
}

export async function killWindow(windowId: string | null | undefined): Promise<void> {
  if (!windowId) return;
  await tmux(['kill-window', '-t', windowId], { check: false });
}

// Window exists and its (first) pane's process is still running.
export async function windowAlive(windowId: string | null | undefined): Promise<boolean> {
  if (!windowId) return false;
  const r = await tmux(['list-panes', '-t', windowId, '-F', '#{pane_dead}'], { check: false });
  if (r.code !== 0) return false;
  const first = r.stdout.trim().split('\n')[0];
  return first === '0';
}

// Ownership tags: tmux reuses window ids (@0, @1 …) after its server restarts, so a stale id stored for one
// agent can point at another agent's (or the user's) window. Every Sparrow window carries user options
// @sparrow_agent / @sparrow_call; callers check them before acting on an id.
export async function tagWindow(windowId: string, agentId: string, callId: string): Promise<void> {
  await tmux(['set-option', '-w', '-t', windowId, '@sparrow_agent', agentId]);
  await tmux(['set-option', '-w', '-t', windowId, '@sparrow_call', callId]);
}

export interface WindowInfo { id: string; agent: string; call: string; dead: boolean }

// One round-trip: null when the window does not exist.
export async function windowInfo(windowId: string | null | undefined): Promise<WindowInfo | null> {
  if (!windowId) return null;
  const r = await tmux(['display-message', '-p', '-t', windowId, '#{window_id}\t#{@sparrow_agent}\t#{@sparrow_call}\t#{pane_dead}'], { check: false });
  if (r.code !== 0) return null;
  const [id, agent, call, dead] = r.stdout.replace(/\n$/, '').split('\t');
  if (id !== windowId) return null;
  return { id, agent: agent ?? '', call: call ?? '', dead: dead === '1' };
}

export async function panePid(windowId: string): Promise<number | null> {
  const r = await tmux(['list-panes', '-t', windowId, '-F', '#{pane_pid}'], { check: false });
  if (r.code !== 0) return null;
  const n = Number(r.stdout.trim().split('\n')[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Strip ANSI CSI/OSC sequences and stray control chars (keep \n and \t).
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export async function capture(windowId: string, lines = 200): Promise<string> {
  const r = await tmux(['capture-pane', '-p', '-J', '-t', windowId, '-S', `-${Math.max(0, lines)}`], { check: false });
  if (r.code !== 0) return '';
  return stripAnsi(r.stdout).replace(/[ \t]+$/gm, '').replace(/\n+$/, '') + '\n';
}

export async function sendKeys(windowId: string, ...keys: string[]): Promise<void> {
  await tmux(['send-keys', '-t', windowId, ...keys]);
}

// Load `text` into a uniquely named buffer and paste it as a bracketed paste (-p) — the TUI sees one paste,
// not a sequence of keystrokes, so embedded newlines don't submit early. -d deletes the buffer afterwards.
// -r keeps LF as LF (default converts LF→CR, which some TUIs treat as Enter even inside a paste).
export async function paste(windowId: string, text: string, opts: { keepLF?: boolean } = {}): Promise<void> {
  const buf = `sparrow-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await tmux(['load-buffer', '-b', buf, '-'], { stdin: text });
  const args = ['paste-buffer', '-p', '-d', '-b', buf, '-t', windowId];
  if (opts.keepLF) args.splice(1, 0, '-r');
  await tmux(args);
}

export async function windowExists(windowId: string): Promise<boolean> {
  const r = await tmux(['display-message', '-p', '-t', windowId, '#{window_id}'], { check: false });
  return r.code === 0 && r.stdout.trim() === windowId;
}

export async function killSession(session: string): Promise<void> {
  await tmux(['kill-session', '-t', `=${session}`], { check: false });
}

export async function killServer(): Promise<void> {
  // Only ever call this on a private socket (tests).
  if (!tmuxSocket()) throw new Error('refusing to kill the default tmux server');
  await tmux(['kill-server'], { check: false });
}
