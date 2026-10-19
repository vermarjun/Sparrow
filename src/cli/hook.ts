// `sparrow hook <kind> …` — called by harness hooks/plugins and by launch scripts inside agent windows.
// Contract: a no-op (exit 0, prints nothing) when SPARROW_AGENT_ID is unset, so global installs never
// affect the user's own sessions. Never hangs the harness: hard 10 s budget; any error → exit 0, silent.
//
// Kinds:
//   claude-stop                    Claude Code Stop hook (stdin JSON). Prints {"decision":"block","reason"} when told to.
//   codex-notify <json>            Codex `notify` program (JSON payload appended as the last arg).
//   opencode-idle --session S [--last-message T]   OpenCode plugin fallback (the plugin normally uses HTTP directly).
//   opencode-session --session S
//   session --session S            generic: report the harness session id
//   turn-end [--session S] [--last-message T] [--harness H] [--stop-hook-active]   generic (fake harness); prints the JSON reply
//   provider-error --message T     the model provider failed (OpenCode session.error; the fake harness simulates it)
//   exit --code N                  launch script, after the harness process ended
import { parseArgs } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { api } from './client';
import { agentDir } from '../harness/env';
import type { HarnessName, TurnEndReq, TurnEndRes } from '../shared/types';

const BUDGET_MS = 10_000;
const MAX_LAST_MESSAGE = 4000;

export async function runHook(kind: string, args: string[]): Promise<number> {
  if (!process.env.SPARROW_AGENT_ID) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([
      handle(kind, args),
      new Promise<string | null>((resolve) => {
        timer = setTimeout(() => resolve(null), BUDGET_MS);
      }),
    ]);
    if (out) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  } catch {
    // swallow: a hook must never break the harness
  } finally {
    if (timer) clearTimeout(timer);
  }
  return 0;
}

const opts = { retries: 1, timeoutMs: 8_000 };

// Debug trail: <SPARROW_HOME>/agents/<id>/hooks.log (one line per hook, payloads clipped). Best effort.
function trail(kind: string, detail: unknown) {
  try {
    const dir = agentDir(process.env.SPARROW_AGENT_ID!);
    mkdirSync(dir, { recursive: true });
    const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
    appendFileSync(join(dir, 'hooks.log'), `${new Date().toISOString()} ${process.env.SPARROW_CALL_ID ?? '-'} ${kind} ${d.slice(0, 2000)}\n`);
  } catch {}
}

function flags(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    strict: false,
    allowPositionals: true,
    options: {
      session: { type: 'string' },
      'last-message': { type: 'string' },
      message: { type: 'string' },
      'last-message-file': { type: 'string' },
      harness: { type: 'string' },
      code: { type: 'string' },
      'stop-hook-active': { type: 'boolean' },
    },
  });
  return { values: values as Record<string, string | boolean | undefined>, positionals };
}

const clip = (s: string | undefined | null) => {
  if (!s) return undefined;
  const t = s.trim();
  return t.length > MAX_LAST_MESSAGE ? '…' + t.slice(-MAX_LAST_MESSAGE) : t;
};

async function turnEnd(req: TurnEndReq): Promise<TurnEndRes> {
  return api<TurnEndRes>('POST', '/api/hooks/turn-end', req, opts);
}

async function handle(kind: string, args: string[]): Promise<string | null> {
  if (kind !== 'claude-stop' && kind !== 'codex-notify') trail(kind, args);
  switch (kind) {
    case 'claude-stop': {
      const raw = await readStdin(3000);
      trail(kind, raw);
      const p = raw.trim() ? JSON.parse(raw) : {};
      const last = clip(p.last_assistant_message ?? lastAssistantFromTranscript(p.transcript_path));
      // Claude can stop while its own background shells run (it wakes itself when they finish). Tell the
      // server so it allows the stop without nudging (I1 bug 4).
      const bg = Array.isArray(p.background_tasks)
        ? p.background_tasks.filter((t: any) => !t?.status || t.status === 'running').length
        : 0;
      const req: TurnEndReq & { background_tasks_running?: number } = {
        harness: 'claude',
        session_id: typeof p.session_id === 'string' ? p.session_id : undefined,
        last_message: last,
        stop_hook_active: !!p.stop_hook_active,
      };
      if (bg > 0) req.background_tasks_running = bg;
      const res = await turnEnd(req);
      if (res?.action === 'block' && res.reason) return JSON.stringify({ decision: 'block', reason: res.reason });
      return null;
    }
    case 'codex-notify': {
      // Codex appends the JSON payload as the final argument.
      const json = args[args.length - 1];
      trail(kind, json ?? '');
      const p = json ? JSON.parse(json) : {};
      if (p.type && p.type !== 'agent-turn-complete') return null;
      if (isCodexTitleTurn(p)) return null;
      await turnEnd({
        harness: 'codex',
        session_id: p['thread-id'] ?? p.thread_id ?? undefined,
        last_message: clip(p['last-assistant-message'] ?? p.last_assistant_message),
      });
      return null;
    }
    case 'opencode-idle':
    case 'turn-end': {
      const { values } = flags(args);
      const harness = (values.harness as string) ?? (kind === 'opencode-idle' ? 'opencode' : process.env.SPARROW_HARNESS ?? 'fake');
      let last = values['last-message'] as string | undefined;
      const lf = values['last-message-file'] as string | undefined;
      if (!last && lf && existsSync(lf)) last = readFileSync(lf, 'utf8');
      const res = await turnEnd({
        harness: harness as HarnessName,
        session_id: (values.session as string) || undefined,
        last_message: clip(last),
        stop_hook_active: !!values['stop-hook-active'],
      });
      return kind === 'turn-end' ? JSON.stringify(res) : null;
    }
    case 'opencode-session':
    case 'session': {
      const { values } = flags(args);
      const s = values.session as string | undefined;
      if (s) await api('POST', '/api/hooks/session', { session_id: s }, opts);
      return null;
    }
    case 'provider-error': {
      const { values } = flags(args);
      const message = String(values.message ?? '').trim();
      if (message) await api('POST', '/api/hooks/provider-error', { harness: process.env.SPARROW_HARNESS || undefined, session_id: (values.session as string) || undefined, message }, opts);
      return null;
    }
    case 'exit': {
      const { values, positionals } = flags(args);
      const n = Number(values.code ?? positionals[0] ?? -1);
      await api('POST', '/api/hooks/exit', { code: Number.isFinite(n) ? n : -1 }, opts);
      return null;
    }
    default:
      return null;
  }
}

// Codex 0.162 runs a hidden title-generation turn on a separate thread after the first prompt and fires
// `notify` for it too (other thread-id, reply like {"title":"…"}), sometimes BEFORE the real turn ends.
// Forwarding it would store a wrong session id and look like a turn end without a report.
export function isCodexTitleTurn(p: any): boolean {
  const inputs: unknown[] = Array.isArray(p?.['input-messages']) ? p['input-messages'] : [];
  const first = typeof inputs[0] === 'string' ? (inputs[0] as string) : '';
  if (/^Generate a concise, single-line task title/i.test(first)) return true;
  const last = String(p?.['last-assistant-message'] ?? '').trim();
  return inputs.length <= 1 && /^\{\s*"title"\s*:\s*"[^"]*"\s*\}$/.test(last) && /\btitle\b/i.test(first);
}

async function readStdin(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  return await new Promise<string>((resolve) => {
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    const t = setTimeout(done, timeoutMs);
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(t);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      done();
    });
  });
}

// Last assistant text in a Claude transcript JSONL (reads only the tail of big files).
export function lastAssistantFromTranscript(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path || !existsSync(path)) return undefined;
  const size = statSync(path).size;
  const want = Math.min(size, 512 * 1024);
  const buf = Buffer.alloc(want);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, want, size - want);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type !== 'assistant') continue;
    const content = e.message?.content;
    const text = Array.isArray(content)
      ? content.filter((c: any) => c?.type === 'text' && c.text).map((c: any) => c.text).join('\n')
      : typeof content === 'string' ? content : '';
    if (text.trim()) return text;
  }
  return undefined;
}

if (import.meta.main) {
  const [kind, ...rest] = process.argv.slice(2);
  process.exit(await runHook(kind ?? '', rest));
}
