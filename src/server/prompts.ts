// System prompt, envelope and notice texts (CONTRACT §7).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSETS } from '../shared/config';
import type { Agent, Message, Project, Resume } from '../shared/types';
import { renderResumeText } from './resumes';

export const PROTOCOL_PATH = join(ASSETS, 'protocol.md');

export const FALLBACK_PROTOCOL = `# Sparrow protocol

You are @{{handle}} ({{title}}), an agent in project {{project}}, hired by @{{parent}}.
Agent id: {{agent_id}}. Harness: {{harness}} · model {{model}} · effort {{effort}}. Folder: {{cwd}}. tmux window: {{tmux}}.

Nobody reads this window. Communicate ONLY through the \`sparrow\` CLI:
- \`sparrow update "did X; next Y"\` at milestones (about every 10 minutes).
- When finished: \`sparrow done - <<'EOF'\` with sections ## Result, ## Evidence, ## Files, ## Next, then EOF — and STOP.
- When blocked: \`sparrow ask "<question>"\`, then stop; the answer resumes you.
- After delegating (captains): \`sparrow wait "<reason>"\`, then stop; any message resumes you.
- Messages reach you through \`sparrow inbox\` (and \`inbox --wait\`), the start of each call, and turn-end. Other sparrow commands end with a stderr line \`📨 N unread ... Read: sparrow inbox\` when messages wait: run \`sparrow inbox\` then, and act on them before finishing. A refused \`done\`/\`ask\`/\`wait\` (a \`Not sent:\` line) consumes nothing: run \`sparrow inbox\`, then report again.
- After done the window closes; you will be resumed with full memory when someone messages you.
- Read a task's board ticket with \`sparrow card show TOR-12\`. On your assigned card you may add a comment, tick a check,
  set or clear \`blocked_on\`, or move it to Review. \`done\` with status ok moves your in-progress card to Review; never move a card to Done.
- Hiring: {{can_hire}} Stay in {{cwd}}. No git commits or pushes unless your task says so.

## Board tickets
Card refs accept \`12\`, \`#12\` or \`TOR-12\`. Search \`sparrow card list\` before proposing; make one card one shippable job.
Write every ticket so a human can triage it in ~5 seconds and an AI can start without questions:
- Title: one outcome-first, verb-first sentence (<=70 chars): what changes for whom.
- Context: why now, who asked and where it came from, what it unblocks (<=2 lines).
- Problem: \`Observed: … Expected: …\` (<=3 lines).
- Approach: plain English, no code, <=5 lines; name the main risk or alternative.
- Done when: 2–7 one-sentence checks, each binary and verifiable without asking.
- Always give impact, effort and an estimate. Pick low|medium|high honestly; double the estimate for under-planning.
- urgent means someone is blocked now. blocked_on names the person or thing you are waiting for. Use active voice and short sentences.
Use \`sparrow card note\`, \`card check\`, \`card block\`, and \`card move … review\` for assigned ticket work.
`;

export interface PromptVars {
  handle: string; title: string; project: string; parent: string; cwd: string; harness: string; model: string; effort: string;
  agent_id: string; can_hire: string; tmux: string;
}

/** Amendment A2: {{can_hire}} as a full sentence. */
export function canHireSentence(canHire: string[]): string {
  if (!canHire.length) return 'You may NOT hire anyone; never run `sparrow hire`.';
  const guidance = 'Hire them with their configured model and effort; pass --model/--effort only if your task explicitly asks.';
  if (canHire.includes('*')) return `You may hire any resume, only via \`sparrow hire\`. ${guidance}`;
  return `You may hire these resumes, only via \`sparrow hire\`: ${canHire.join(', ')}. ${guidance}`;
}

export function fillTemplate(tpl: string, vars: PromptVars): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k: string) => (k in vars ? (vars as any)[k] : all));
}

export function renderSystemPrompt(agent: Agent, resume: Resume, parent: Agent | null, project: Project, protocolPath = PROTOCOL_PATH): string {
  let tpl = FALLBACK_PROTOCOL;
  try { if (existsSync(protocolPath)) tpl = readFileSync(protocolPath, 'utf8'); } catch { /* fallback */ }
  const vars: PromptVars = {
    handle: agent.handle,
    title: agent.title || resume.title,
    project: project.id,
    parent: parent?.handle ?? 'captain',
    cwd: agent.cwd,
    harness: agent.harness,
    model: agent.model || 'harness default',
    effort: agent.effort || 'default',
    agent_id: agent.id,
    can_hire: canHireSentence(agent.can_hire),
    tmux: `${agent.tmux_session}:${agent.tmux_window}`,
  };
  return `${fillTemplate(tpl, vars).trimEnd()}\n\n# Your role\n\n${renderResumeText(resume.body, agent).trim()}\n`;
}

export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function hhmmss(ms: number): string {
  return `${hhmm(ms)}:${String(new Date(ms).getSeconds()).padStart(2, '0')}`;
}

/** The agent a message is about: its sender, or `meta.about` for system notices. */
export function aboutOf(m: Message): string {
  return m.from_id === 'system' && typeof m.meta?.about === 'string' ? m.meta.about : m.from_id;
}

/** Messages grouped by the agent they are about; groups in order of first appearance, seq order inside each. */
export function groupByAbout<T extends Message>(messages: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const m of [...messages].sort((a, b) => a.seq - b.seq)) {
    const k = aboutOf(m);
    const g = groups.get(k);
    if (g) g.push(m);
    else groups.set(k, [m]);
  }
  return [...groups.values()];
}

/** Resolves an agent id to a handle ('system' for system). */
export type HandleOf = (id: string) => string;

export function messageHeader(m: Message, handleOf: HandleOf): string {
  const from = m.from_id === 'system' ? 'system' : `@${handleOf(m.from_id)}`;
  const t = hhmm(m.created_at);
  const card = m.card_id != null ? ` · card #${m.card_id}` : '';
  let label: string;
  switch (m.kind) {
    case 'task': label = `task from ${from}`; break;
    case 'question': label = `question from ${from}`; break;
    case 'result': label = `result from ${from}${m.meta?.status ? ` (${m.meta.status})` : ''}${m.meta?.released ? ' · released (one-shot)' : ''}`; break;
    case 'system': label = 'system notice'; break;
    case 'update': label = `update from ${from}`; break;
    default: label = `DM from ${from}`;
  }
  return `── ${label} · ${t}${card} ──`;
}

export interface EnvelopeOpts { projectId?: string; prefix?: string; isCaptain?: boolean }

export function envelopeFooter(isCaptain: boolean): string {
  return isCaptain
    ? 'Report with the sparrow CLI: `sparrow update` as you go, `sparrow wait` while your hires work, then `sparrow done` (or `sparrow ask` if blocked).'
    : 'Report with the sparrow CLI: `sparrow update` as you go, then `sparrow done` (or `sparrow ask` if blocked).';
}

export function renderEnvelope(agent: Agent, messages: Message[], handleOf: HandleOf, opts: EnvelopeOpts = {}): string {
  const parts: string[] = [];
  if (opts.prefix) parts.push(opts.prefix.trim());
  if (messages.length) {
    const n = messages.length;
    const proj = opts.projectId ?? agent.project_id;
    parts.push(`[sparrow] ${n} new message${n === 1 ? '' : 's'} for @${agent.handle} (project ${proj}):`);
    // Per agent: its updates (one timed line each), then its result / question / notice in full.
    for (const group of groupByAbout(messages)) {
      let updates: Message[] = [];
      const flush = () => {
        if (!updates.length) return;
        const lines = updates.map((u) => `${hhmmss(u.created_at)}  ${u.text.trim().replace(/\n/g, '\n          ')}${u.card_id != null ? ` (card #${u.card_id})` : ''}`);
        parts.push(`── updates from @${handleOf(updates[0].from_id)} ──\n${lines.join('\n')}`);
        updates = [];
      };
      for (const m of group) {
        if (m.kind === 'update') { updates.push(m); continue; }
        flush();
        parts.push(`${messageHeader(m, handleOf)}\n${m.text.trim()}`);
      }
      flush();
    }
  }
  parts.push(envelopeFooter(opts.isCaptain ?? agent.can_hire.length > 0));
  return parts.join('\n\n') + '\n';
}

export const NUDGE_REPORT =
  "[sparrow] You stopped without reporting. Nobody reads this window. If you are finished run `sparrow done - <<'EOF' …` now; if you need something run `sparrow ask \"…\"`; if you are waiting on others run `sparrow wait \"…\"`.";

export function nudgeQuiet(minutes: number): string {
  return `[sparrow] No progress update for ${minutes} minutes. Post one line with \`sparrow update "did X; next Y"\`, then continue.`;
}

export function crashResume(code: number | null, lastUpdate: string | null): string {
  return `[sparrow] Your previous session ended unexpectedly (exit ${code ?? '?'}). Continue your task from where you left off. Your last update was: «${lastUpdate ?? 'none'}».`;
}

export function freshReplay(agent: Agent, task: Message | null, recent: Message[], lastUpdate: string | null, handleOf: HandleOf, code: number | null = null): string {
  const lines = [
    `[sparrow] Your previous session ended unexpectedly (exit ${code ?? '?'}) and could not be resumed, so this is a FRESH session without your earlier memory. Here is what you need to continue.`,
    '',
    '## Your task',
    task ? `${messageHeader(task, handleOf)}\n${task.text.trim()}` : '(task not found)',
  ];
  if (recent.length) {
    lines.push('', '## Recent messages (oldest first)');
    for (const m of recent) lines.push(`${messageHeader(m, handleOf)}\n${m.text.trim()}`);
  }
  lines.push('', `## Your last update\n«${lastUpdate ?? 'none'}»`, '', 'Check the files in your folder for work already done, then continue.');
  return lines.join('\n');
}
