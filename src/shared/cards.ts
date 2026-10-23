// Board v2 pure helpers, shared by server, CLI and web (.orchestra/BOARD-CONTRACT.md). No I/O.
import type { Card, CardLevel, CardNote, CardState } from './types';

// ---------------------------------------------------------------- ticket keys
// Card ids are global, so the key prefix is cosmetic: TOR-19 and SPA-19 can't both exist. Any prefix parses.

/** 'tortuga' → 'TOR', 'tortuga-ledger' → 'TOR', 'x' → 'X'; never empty. */
export function keyPrefix(projectId: string): string {
  const letters = projectId.replace(/[^a-z0-9]/gi, '').toUpperCase();
  return letters.slice(0, 3) || 'CARD';
}

export function cardKey(c: Pick<Card, 'id' | 'project_id'>): string {
  return `${keyPrefix(c.project_id)}-${c.id}`;
}

/** '19', '#19', 'TOR-19', 'tor-19', 'TOR 19' → 19; anything else → null. */
export function parseCardRef(ref: string | number | null | undefined): number | null {
  if (typeof ref === 'number') return Number.isInteger(ref) && ref > 0 ? ref : null;
  if (typeof ref !== 'string') return null;
  const m = ref.trim().match(/^(?:#|[a-z][a-z0-9]*[-\s])?(\d+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------- levels, estimates

export const LEVEL_RANK: Record<CardLevel, number> = { low: 1, medium: 2, high: 3 };

/** 'l'/'lo'/'low'/'1' → 'low', 'm'/'med'/'2' → 'medium', 'h'/'hi'/'3' → 'high'; else null. */
export function parseLevel(v: unknown): CardLevel | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim().toLowerCase();
  if (['l', 'lo', 'low', '1'].includes(s)) return 'low';
  if (['m', 'med', 'mid', 'medium', '2'].includes(s)) return 'medium';
  if (['h', 'hi', 'high', '3'].includes(s)) return 'high';
  return null;
}

export const DAY_MIN = 8 * 60; // an estimate "day" is a working day

/** '45' / '45m' → 45, '2h' → 120, '1.5h' → 90, '1h30m' / '1h 30m' → 90, '1d' → 480; invalid / ≤ 0 → null. */
export function parseEstimate(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseEstimate(Number(s));
  const re = /(\d+(?:\.\d+)?)(d|h|m)/g;
  let total = 0, used = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    total += Number(m[1]) * (m[2] === 'd' ? DAY_MIN : m[2] === 'h' ? 60 : 1);
    used += m[0].length;
  }
  if (used !== s.length || total <= 0) return null;
  return Math.round(total);
}

/** 45 → '45m', 120 → '2h', 90 → '1h 30m', 480 → '1d', 600 → '1d 2h'. */
export function formatEstimate(min: number | null | undefined): string {
  if (min == null || !(min > 0)) return '';
  const d = Math.floor(min / DAY_MIN), h = Math.floor((min % DAY_MIN) / 60), m = Math.round(min % 60);
  const parts = [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean) as string[];
  return parts.slice(0, 2).join(' ') || '0m';
}

/** Wall-clock duration: 95_000 → '2m', 5_400_000 → '1h 30m', 3 days → '3d 0h'. */
export function formatSpan(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  const min = Math.round(ms / 60_000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ---------------------------------------------------------------- timings

export interface CardTimings {
  in_state: Record<CardState, number>; // total ms spent in each state (all visits; the current visit counts up to `now`)
  started_at: number | null;           // first time it entered in_progress
  review_at: number | null;            // latest time it entered review
  done_at: number | null;              // latest time it entered done (null unless it is in done now)
  build_ms: number;                    // = in_state.in_progress
  review_ms: number;                   // = in_state.review
  active_ms: number;                   // build + review (wall clock, review includes waiting for the user)
  cycle_ms: number | null;             // started_at → done_at (or now); null if never started
  lead_ms: number;                     // created → done_at (or now)
  estimate_ms: number | null;
  ratio: number | null;                // build_ms / estimate_ms (1.0 = on estimate; > 1 = over). Review is the user's
                                       // latency, not the work, so it is reported next to the ratio, never inside it.
  reopened: number;                    // times it went back from review/done to an earlier working state
}

const ZERO = (): Record<CardState, number> => ({ proposed: 0, todo: 0, in_progress: 0, review: 0, done: 0, dropped: 0 });

export function cardTimings(c: Pick<Card, 'created_at' | 'state' | 'history' | 'estimate_min'>, now = Date.now()): CardTimings {
  const hist = [...(c.history ?? [])].sort((a, b) => a.at - b.at);
  // Cards from before v2 have no history: treat them as created in their current state.
  if (!hist.length) hist.push({ at: c.created_at, by: '', from: null, to: c.state });
  const in_state = ZERO();
  let started_at: number | null = null, review_at: number | null = null, last_done: number | null = null, reopened = 0;
  for (let i = 0; i < hist.length; i++) {
    const t = hist[i];
    const end = i + 1 < hist.length ? hist[i + 1].at : now;
    in_state[t.to] += Math.max(0, end - t.at);
    if (t.to === 'in_progress' && started_at == null) started_at = t.at;
    if (t.to === 'review') review_at = t.at;
    if (t.to === 'done') last_done = t.at;
    if ((t.from === 'review' || t.from === 'done') && (t.to === 'in_progress' || t.to === 'todo')) reopened++;
  }
  const done_at = c.state === 'done' ? last_done : null;
  const build_ms = in_state.in_progress, review_ms = in_state.review, active_ms = build_ms + review_ms;
  const estimate_ms = c.estimate_min ? c.estimate_min * 60_000 : null;
  return {
    in_state, started_at, review_at, done_at, build_ms, review_ms, active_ms,
    cycle_ms: started_at == null ? null : (done_at ?? now) - started_at,
    lead_ms: (done_at ?? now) - c.created_at,
    estimate_ms, ratio: estimate_ms && build_ms ? build_ms / estimate_ms : null, reopened,
  };
}

// ---------------------------------------------------------------- triage

/** High return for low effort: effort low and impact medium/high. */
export function isQuickWin(c: Pick<Card, 'impact' | 'effort'>): boolean {
  return c.effort === 'low' && (c.impact === 'high' || c.impact === 'medium');
}

/** Return per effort: impact rank / effort rank (unknown impact → 0, unknown effort → medium). */
export function roiScore(c: Pick<Card, 'impact' | 'effort'>): number {
  const i = c.impact ? LEVEL_RANK[c.impact] : 0;
  const e = c.effort ? LEVEL_RANK[c.effort] : 2;
  return i / e;
}

export type CardSort = 'manual' | 'newest' | 'oldest' | 'urgent' | 'roi' | 'impact' | 'effort' | 'estimate' | 'updated';
export const CARD_SORTS: { id: CardSort; label: string }[] = [
  { id: 'manual', label: 'Manual order' },
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'urgent', label: 'Urgent & blocked first' },
  { id: 'roi', label: 'Best return for effort' },
  { id: 'impact', label: 'Highest return' },
  { id: 'effort', label: 'Lowest effort' },
  { id: 'estimate', label: 'Shortest estimate' },
  { id: 'updated', label: 'Recently updated' },
];

type Sortable = Pick<Card, 'id' | 'position' | 'created_at' | 'updated_at' | 'urgent' | 'blocked_on' | 'impact' | 'effort' | 'estimate_min'>;

/** Sorted copy. Every mode ends with a stable tie-break (position, then id); 'manual' is just that. */
export function sortCardsBy<T extends Sortable>(cards: T[], mode: CardSort = 'manual'): T[] {
  const manual = (a: T, b: T) => a.position - b.position || a.id - b.id;
  const flag = (a: T, b: T) => Number(b.urgent) - Number(a.urgent) || Number(!!b.blocked_on) - Number(!!a.blocked_on);
  const lv = (x: CardLevel | null, missing: number) => (x ? LEVEL_RANK[x] : missing);
  const cmp: Record<CardSort, (a: T, b: T) => number> = {
    manual: () => 0,
    newest: (a, b) => b.created_at - a.created_at,
    oldest: (a, b) => a.created_at - b.created_at,
    urgent: (a, b) => flag(a, b) || b.created_at - a.created_at,
    roi: (a, b) => roiScore(b) - roiScore(a) || flag(a, b),
    impact: (a, b) => lv(b.impact, 0) - lv(a.impact, 0) || lv(a.effort, 4) - lv(b.effort, 4),
    effort: (a, b) => lv(a.effort, 4) - lv(b.effort, 4) || lv(b.impact, 0) - lv(a.impact, 0),
    estimate: (a, b) => (a.estimate_min ?? Infinity) - (b.estimate_min ?? Infinity) || 0,
    updated: (a, b) => b.updated_at - a.updated_at,
  };
  return [...cards].sort((a, b) => cmp[mode](a, b) || manual(a, b));
}

// ---------------------------------------------------------------- the brief an agent receives

export const STATE_LABEL: Record<CardState, string> = {
  proposed: 'Proposed', todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done', dropped: 'Dropped',
};

const noteKind = (n: CardNote) => n.kind ?? 'comment';
const isoDay = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

/**
 * The full ticket as markdown: what `sparrow card show N` prints, what a hire with `--card N` appends to the task,
 * and what the UI's "Copy brief" copies. `who` gets an agent id, 'user', or a note's `by` (a handle) and returns a
 * display name ('@maya', 'you').
 */
export function cardBrief(c: Card, who: (id: string) => string = (id) => id): string {
  const out: string[] = [];
  out.push(`# ${cardKey(c)} · ${c.title}`);
  const meta = [
    `state: ${STATE_LABEL[c.state]}`,
    c.urgent ? 'URGENT' : '',
    c.blocked_on ? `BLOCKED on ${c.blocked_on}` : '',
    c.later_at ? 'shelved (later)' : '',
    c.category ? `category: ${c.category}` : '',
    c.tags?.length ? `tags: ${c.tags.join(', ')}` : '',
    c.impact ? `return: ${c.impact}` : '',
    c.effort ? `effort: ${c.effort}` : '',
    c.estimate_min ? `estimate: ${formatEstimate(c.estimate_min)}` : '',
    c.assignee_id ? `assignee: ${who(c.assignee_id)}` : '',
    `proposed by ${who(c.created_by)} on ${isoDay(c.created_at)} UTC`,
  ].filter(Boolean);
  out.push(meta.join(' · '));
  const section = (title: string, body: string) => { if (body?.trim()) out.push('', `## ${title}`, body.trim()); };
  section('Context', c.context);
  section('Problem', c.problem);
  section('Approach', c.approach);
  if (c.checks?.length) out.push('', '## Done when', ...c.checks.map((k, i) => `${i + 1}. [${k.done ? 'x' : ' '}] ${k.text}`));
  section('More details', c.details);
  const comments = (c.notes ?? []).filter((n) => noteKind(n) === 'comment');
  if (comments.length) out.push('', '## Comments', ...comments.map((n) => `- ${who(n.by)} · ${isoDay(n.at)}: ${n.text.trim().replace(/\n/g, '\n  ')}`));
  return out.join('\n');
}
