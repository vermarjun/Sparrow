#!/usr/bin/env bun
// Fake harness: behaves like an interactive agent TUI from the server's point of view, without a model.
// - Reads the first prompt from --prompt-file, later prompts from the terminal (typed or bracketed-pasted + Enter).
// - Acts on directives found on their own line anywhere in a prompt:
//     FAKE:update <text>     sparrow update <text>
//     FAKE:done <text>       sparrow done <text>
//     FAKE:ask <text>        sparrow ask <text>
//     FAKE:wait [reason]     sparrow wait [reason]
//     FAKE:sleep <sec>       sleep (busy)
//     FAKE:crash <code>      exit with <code> (default 3)
//     FAKE:exit0             exit 0 (like the user typing /exit)
//     FAKE:idle              end the turn here (remaining directives ignored)
//     FAKE:silent            from now on, prompts without directives get no reply (only a turn end)
//     FAKE:remember <word>   remember a word in this session (persists across resume)
//     FAKE:recall            sparrow update "recall: <remembered words>"
//   No directive (and not silent) → `sparrow update "fake: working on …"` + `sparrow done "fake: done"`.
// - After every prompt it signals a turn end via `sparrow hook turn-end` (like Claude's Stop hook) and acts on a
//   {action:'block', reason} reply by treating `reason` as the next prompt.
// - Stays running when idle until the window is killed.
import { parseArgs } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../shared/config';

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: false,
  options: {
    'prompt-file': { type: 'string' },
    'system-file': { type: 'string' },
    session: { type: 'string' },
    'agent-dir': { type: 'string' },
    resume: { type: 'boolean' },
  },
});

const session = String(values.session ?? `fake-${crypto.randomUUID()}`);
const agentDir = String(values['agent-dir'] ?? process.cwd());
const memFile = join(agentDir, 'fake-memory', `${session}.txt`);
const hookTs = join(REPO_ROOT, 'src', 'cli', 'hook.ts');
const cliAvailable = existsSync(join(REPO_ROOT, 'src', 'cli', 'main.ts'));
let silent = false;

const out = (s: string) => process.stdout.write(s.replace(/\n/g, '\r\n') + '\r\n');

async function run(argv: string[]): Promise<{ code: number; stdout: string }> {
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: process.env });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout: o + e };
}

// Post through the real CLI (`sparrow` resolved from PATH, proving PATH + env reach the agent's tools).
// Before the CLI dispatcher exists (track T3 not landed), fall back to the HTTP API directly.
async function sparrow(cmd: string, text?: string, extra: string[] = []) {
  out(`• sparrow ${cmd}${text ? ' ' + JSON.stringify(text.slice(0, 80)) : ''}`);
  if (cliAvailable) {
    const r = await run(['sparrow', cmd, ...(text !== undefined ? [text] : []), ...extra]);
    out(r.stdout.trim().split('\n').map((l) => '  ' + l).join('\n'));
    return;
  }
  const { api } = await import('../cli/client');
  const body: Record<string, any> =
    cmd === 'update' ? { text } : cmd === 'done' ? { summary: text, status: 'ok' } : cmd === 'ask' ? { question: text } : { reason: text };
  try {
    const r = await api('POST', `/api/${cmd}`, body, { retries: 1 });
    out('  ' + JSON.stringify(r).slice(0, 200));
  } catch (e) {
    out('  error: ' + (e as Error).message);
  }
}

async function turnEnd(last: string): Promise<{ action?: string; reason?: string }> {
  const r = await run([process.execPath, hookTs, 'turn-end', '--session', session, '--harness', process.env.SPARROW_HARNESS ?? 'fake', '--last-message', last]);
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
  } catch {
    return {};
  }
}

async function handlePrompt(text: string, depth = 0): Promise<void> {
  out(`\n> ${text.split('\n').slice(0, 6).join('\n  ')}${text.split('\n').length > 6 ? '\n  …' : ''}`);
  const directives = text
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*FAKE:([a-z0-9]+)\s*(.*?)\s*$/i))
    .filter(Boolean) as RegExpMatchArray[];
  let last = 'fake: nothing to do';

  if (directives.length === 0) {
    if (!silent) {
      const first = text.split('\n').find((l) => l.trim() && !l.startsWith('[sparrow]'))?.trim() ?? text.trim();
      await sparrow('update', `fake: working on ${first.slice(0, 60)}`);
      await sparrow('done', 'fake: done');
      last = 'fake: done';
    } else {
      last = 'fake: (silent)';
    }
  }

  loop: for (const [, name, arg] of directives) {
    switch (name.toLowerCase()) {
      case 'update':
        await sparrow('update', arg || 'fake update');
        last = arg;
        break;
      case 'done':
        await sparrow('done', arg || 'fake: done');
        last = arg;
        break;
      case 'ask':
        await sparrow('ask', arg || 'fake question?');
        last = arg;
        break;
      case 'wait':
        await sparrow('wait', arg || 'waiting');
        last = arg;
        break;
      case 'sleep':
        out(`• sleeping ${arg}s`);
        await Bun.sleep(Number(arg || 1) * 1000);
        break;
      case 'crash':
        out(`• crashing with ${arg || 3}`);
        process.exit(Number(arg || 3));
      case 'exit0':
        out('• exiting 0');
        process.exit(0);
      case 'idle':
        last = 'fake: idle without reporting';
        break loop;
      case 'silent':
        silent = true;
        break;
      case 'remember':
        mkdirSync(join(agentDir, 'fake-memory'), { recursive: true });
        appendFileSync(memFile, arg + '\n');
        out(`• remembered ${arg}`);
        last = `remembered ${arg}`;
        break;
      case 'recall': {
        const words = existsSync(memFile) ? readFileSync(memFile, 'utf8').trim().split('\n').join(' ') : '';
        await sparrow('update', `recall: ${words || '(nothing)'}`);
        last = `recall: ${words}`;
        break;
      }
      default:
        out(`• unknown directive ${name}`);
    }
  }

  const res = await turnEnd(last);
  out(`• turn end → ${JSON.stringify(res)}`);
  if (res.action === 'block' && res.reason && depth < 10) await handlePrompt(res.reason, depth + 1);
}

// ---- prompt queue (prompts typed while busy are queued, like a real TUI) ----
const queue: string[] = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) await handlePrompt(queue.shift()!);
  } finally {
    busy = false;
  }
  out('fake❯ (idle — type or paste a message)');
}
function submit(text: string) {
  const t = text.replace(/\r\n?/g, '\n').trim();
  if (!t) return;
  queue.push(t);
  void pump();
}

// ---- terminal input: raw mode, bracketed paste ----
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
let buf = '';
let pasted = ''; // completed paste waiting for Enter
let line = '';
function onData(chunk: string) {
  buf += chunk;
  while (buf.length) {
    if (buf.startsWith(PASTE_START)) {
      const end = buf.indexOf(PASTE_END);
      if (end < 0) return; // wait for the rest of the paste
      pasted += buf.slice(PASTE_START.length, end);
      buf = buf.slice(end + PASTE_END.length);
      continue;
    }
    const ch = buf[0];
    if (ch === '\x1b' && PASTE_START.startsWith(buf.slice(0, PASTE_START.length)) && buf.length < PASTE_START.length) return;
    buf = buf.slice(1);
    if (ch === '\r' || ch === '\n') {
      const msg = pasted + line;
      pasted = '';
      line = '';
      out('');
      submit(msg);
    } else if (ch === '\x03') {
      out('^C');
      process.exit(130);
    } else if (ch === '\x7f') {
      line = line.slice(0, -1);
    } else if (ch >= ' ' || ch === '\t') {
      line += ch;
      process.stdout.write(ch);
    }
  }
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('\x1b[?2004h'); // ask the terminal (tmux) for bracketed paste
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c: string) => onData(c));

out(`fake harness · session ${session}${values.resume ? ' (resumed)' : ''}`);
out(`agent ${process.env.SPARROW_AGENT_ID ?? '-'} · call ${process.env.SPARROW_CALL_ID ?? '-'} · ${process.env.SPARROW_URL ?? '-'}`);
out(`cwd ${process.cwd()} · sparrow on PATH: ${Bun.which('sparrow') ?? 'NO'}`);
if (values['system-file'] && existsSync(String(values['system-file']))) {
  out(`system prompt: ${readFileSync(String(values['system-file']), 'utf8').length} chars`);
}
const first = values['prompt-file'] && existsSync(String(values['prompt-file'])) ? readFileSync(String(values['prompt-file']), 'utf8') : '';
if (first.trim()) submit(first);
else out('fake❯ (idle — type or paste a message)');
