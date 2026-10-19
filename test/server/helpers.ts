// Test helpers: in-memory fake spawner, fake clock, temp resumes, request helper.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Spawner, StartSpec } from '../../src/harness/index';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/config';
import type { Agent, ServerEvent } from '../../src/shared/types';
import type { Clock } from '../../src/server/core';
import { type AppDeps, createApp } from '../../src/server/main';

// Hiring snapshots the agent's skills under agentDir(); keep that (and everything else) out of the real home (D6).
process.env.SPARROW_HOME = mkdtempSync(join(tmpdir(), 'sparrow-t1-home-'));

export class FakeSpawner implements Spawner {
  starts: StartSpec[] = [];
  delivers: { agent: Agent; text: string }[] = [];
  stops: { id: string; window: string | null }[] = [];
  captures = 0;
  alive = new Map<string, boolean>();         // window id -> alive
  owner = new Map<string, string>();          // window id -> agent id (T2-style ownership tag)
  refused: { id: string; window: string | null }[] = [];
  reuse: string[] = [];                        // window ids to hand out next (simulates tmux id reuse)
  onDiscover: (() => Promise<void>) | null = null;
  screens = new Map<string, string>();        // agent id -> screen text
  failStart: string | null = null;
  discovered: string | null = null;
  private n = 0;
  async start(spec: StartSpec) {
    this.starts.push(spec);
    if (this.failStart) throw new Error(this.failStart);
    ++this.n;
    const window_id = this.reuse.shift() ?? `@${this.n}`;
    this.alive.set(window_id, true);
    this.owner.set(window_id, spec.agent.id);
    const session_id = spec.agent.harness === 'claude' ? (spec.resume ? spec.agent.session_id : `sess-${this.n}`) : null;
    return { window_id, session_id };
  }
  async deliver(agent: Agent, text: string) { this.delivers.push({ agent, text }); }
  async stop(agent: Agent) {
    const w = agent.tmux_window_id;
    if (w && this.owner.has(w) && this.owner.get(w) !== agent.id) { this.refused.push({ id: agent.id, window: w }); return; }
    this.stops.push({ id: agent.id, window: w });
    if (w) this.alive.set(w, false);
  }
  async isAlive(agent: Agent) {
    const w = agent.tmux_window_id;
    return !!w && this.alive.get(w) === true && (!this.owner.has(w) || this.owner.get(w) === agent.id);
  }
  async capture(agent: Agent, _lines?: number) { this.captures++; return this.screens.get(agent.id) ?? `screen of ${agent.handle}`; }
  async discoverSession(_agent: Agent, _since: number) { if (this.onDiscover) await this.onDiscover(); return this.discovered; }
  startsFor(agentId: string) { return this.starts.filter((s) => s.agent.id === agentId); }
  stopsFor(agentId: string) { return this.stops.filter((s) => s.id === agentId); }
  get calls() { return this.starts.length + this.delivers.length + this.stops.length; }
}

/** Deterministic clock: timers only fire on advance(). */
export class FakeClock implements Clock {
  t = new Date('2026-10-13T14:02:00').getTime();
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn }); return id; }
  clearTimeout(h: unknown) { this.timers.delete(h as number); }
  get pending() { return this.timers.size; }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

export async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

export function resume(name: string, harness: string, extra = '') {
  return `---\nname: ${name}\ntitle: ${name[0].toUpperCase() + name.slice(1)}\ndescription: test ${name}\nharness: ${harness}\n${extra}---\nYou are the ${name}.\n`;
}

export function makeResumesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sparrow-t1-res-'));
  writeFileSync(join(dir, 'builder.md'), resume('builder', 'claude', 'model: haiku\neffort: low\ncan_hire: []\nlimits: { quiet_minutes: 15, max_call_minutes: 90 }\n'));
  writeFileSync(join(dir, 'builder-codex.md'), resume('builder-codex', 'codex'));
  writeFileSync(join(dir, 'researcher.md'), resume('researcher', 'opencode'));
  writeFileSync(join(dir, 'fake.md'), resume('fake', 'fake', 'limits: { quiet_minutes: 1, max_call_minutes: 3 }\n'));
  writeFileSync(join(dir, 'sub-captain.md'), resume('sub-captain', 'claude', 'can_hire: [builder, fake]\n'));
  return dir;
}

export interface Ctx {
  app: ReturnType<typeof createApp>['app'];
  core: ReturnType<typeof createApp>['core'];
  store: ReturnType<typeof createApp>['store'];
  catalogs: ReturnType<typeof createApp>['catalogs'];
  doctor: ReturnType<typeof createApp>['doctor'];
  sp: FakeSpawner;
  clock: FakeClock;
  events: ServerEvent[];
  logs: string[];
  root: string;
  captain: Agent;
  req: <T = any>(method: string, path: string, body?: unknown, as?: string | null, call?: string | null) => Promise<{ status: number; body: T }>;
}

export async function setup(settings: Partial<Settings> = {}, extra: Partial<AppDeps> = {}): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), 'sparrow-t1-proj-'));
  mkdirSync(join(root, 'sub'), { recursive: true });
  const sp = new FakeSpawner();
  const clock = new FakeClock();
  const logs: string[] = [];
  const { app, core, store, events: bus, catalogs, doctor } = createApp({
    spawner: sp,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    resumeDirs: [makeResumesDir()],
    clock,
    log: (l) => logs.push(l),
    tmuxPrefix: 'sptest-',
    protocolPath: '/nonexistent/protocol.md',
    deliverDelayMs: 1000,
    detectRoot: (cwd) => cwd,
    doctorRoot: mkdtempSync(join(tmpdir(), 'sparrow-t1-doc-')),
    doctorShared: [],
    ...extra,
  });
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const req = async (method: string, path: string, body?: unknown, as?: string | null, call?: string | null) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (as) headers['x-sparrow-agent'] = as;
    if (call) headers['x-sparrow-call'] = call;
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, body: parsed };
  };
  const reg = await req('POST', '/api/captains/register', { cwd: root });
  return { app, core, store, catalogs, doctor, sp, clock, events, logs, root, captain: reg.body.agent, req };
}

/** Hire as the captain (or `as`) and return the new agent. */
export async function hire(ctx: Ctx, resumeSlug: string, task: string, extra: Record<string, unknown> = {}, as?: string) {
  const r = await ctx.req('POST', '/api/hire', { resume: resumeSlug, task, ...extra }, as ?? ctx.captain.id);
  if (r.status !== 200) throw new Error(`hire failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.agent as Agent;
}

export const agentOf = (ctx: Ctx, id: string) => ctx.store.getAgent(id)!;
