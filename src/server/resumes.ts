// Resume (role card) loading: RESUMES_DIR/*.md first, then assets/resumes/*.md for slugs the user doesn't have.
// U1: writes go to the first dir (atomic tmp + rename); deleting a slug that a later dir also ships leaves a
// tombstone <dir0>/.deleted/<slug> so the builtin fallback stays hidden.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { HarnessName as H, Resume as R, ResumeWriteReq } from '../shared/types';
import type { Settings as S } from '../shared/config';
import { validSkillName } from '../skills/frontmatter';

export { validSkillName } from '../skills/frontmatter';

export const SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;
// Names kept as written (invalid/unknown ones are reported at grant time), de-duplicated, order preserved.
const skillNames = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x).trim()).filter(Boolean))] : [];

const HARNESSES: H[] = ['claude', 'codex', 'opencode', 'fake'];

function splitFrontmatter(text: string): { fm: string; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return { fm: '', body: text };
  return { fm: m[1], body: m[2] };
}

function parseYaml(fm: string): Record<string, any> {
  const Y = (globalThis as any).Bun?.YAML;
  if (Y?.parse) {
    try { return (Y.parse(fm) as Record<string, any>) ?? {}; } catch { /* fall through */ }
  }
  // Tiny fallback for the flat format: key: value, [a, b], { k: v }.
  const out: Record<string, any> = {};
  for (const line of fm.split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].replace(/\s+#.*$/, '').trim();
    const scalar = (s: string): any => {
      s = s.trim().replace(/^["']|["']$/g, '');
      if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
      if (s === 'null' || s === '~' || s === '') return null;
      if (s === 'true' || s === 'false') return s === 'true';
      return s;
    };
    if (v.startsWith('[')) out[mm[1]] = v.slice(1, -1).split(',').map((x) => scalar(x)).filter((x) => x !== null);
    else if (v.startsWith('{')) {
      const o: Record<string, any> = {};
      for (const kv of v.slice(1, -1).split(',')) {
        const [k, ...rest] = kv.split(':');
        if (k?.trim()) o[k.trim()] = scalar(rest.join(':'));
      }
      out[mm[1]] = o;
    } else out[mm[1]] = scalar(v);
  }
  return out;
}

const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

export function parseResume(text: string, path: string, settings: Pick<S, 'quiet_minutes' | 'max_call_minutes'>): R {
  const { fm, body } = splitFrontmatter(text);
  const d = parseYaml(fm);
  const slug = basename(path).replace(/\.md$/, '');
  const harness = (HARNESSES as string[]).includes(String(d.harness)) ? (d.harness as H) : 'claude';
  const canHire = Array.isArray(d.can_hire) ? d.can_hire.map(String).filter(Boolean) : [];
  const limits = d.limits && typeof d.limits === 'object' ? d.limits : {};
  return {
    slug,
    title: str(d.title) ?? slug,
    description: str(d.description) ?? '',
    harness,
    model: str(d.model),
    effort: str(d.effort),
    can_hire: canHire,
    limits: {
      quiet_minutes: Number(limits.quiet_minutes) > 0 ? Number(limits.quiet_minutes) : settings.quiet_minutes,
      max_call_minutes: Number(limits.max_call_minutes) > 0 ? Number(limits.max_call_minutes) : settings.max_call_minutes,
    },
    body: body.replace(/^\s+/, '').replace(/\s+$/, '') + '\n',
    path,
    skills: skillNames(d.skills),
    ...(d.helper === true ? { helper: true } : {}),
    ...(d.one_shot === true ? { one_shot: true } : {}),
  };
}

/**
 * Fill {{harness}} {{model}} {{effort}} {{runtime}} in resume text from the live settings. Unknown {{x}} stay as is.
 * web/src/lib/resumeVars.ts mirrors this (web cannot import server code): keep the two in step.
 */
export function renderResumeText(text: string, s: { harness: string; model?: string | null; effort?: string | null }): string {
  const model = s.model || 'harness default';
  const effort = s.effort || 'default';
  const vars: Record<string, string> = { harness: s.harness, model, effort, runtime: `${s.harness} · ${model} · effort ${effort}` };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k: string) => (Object.hasOwn(vars, k) ? vars[k] : all));
}

// A description that hard-codes the runtime ("on Codex (gpt-6-luna)", "(Claude Code, Sonnet)") goes stale when the
// harness/model/effort change. Resumes written before the template variables existed carry such text; it is
// replaced by ({{runtime}}) once, so the description always shows the resume's current settings.
const HARNESS_WORD = /\b(?:claude(?: code)?|codex|open ?code)\b/i;
export function templateRuntime(description: string): string {
  if (/\{\{\s*(?:runtime|model|harness|effort)\s*\}\}/.test(description)) return description;
  const onHarness = description.replace(/\s+on (?:claude(?: code)?|codex|open ?code)\s*\([^()]*\)/i, ' ({{runtime}})');
  if (onHarness !== description) return onHarness;
  return description.replace(/\(([^()]*)\)/, (m, inner: string) => (HARNESS_WORD.test(inner) ? '({{runtime}})' : m));
}

/** sha256 of the file content, first 12 hex (ResumeView.hash). */
export const hashText = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

// A YAML scalar that round-trips through Bun.YAML and the fallback parser: plain when safe, else a JSON string
// (a JSON string is a valid YAML double-quoted scalar).
function yamlStr(v: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_ .,()/+=-]*$/.test(v) && !/^(null|true|false|~)$/i.test(v) && !/^-?\d/.test(v) ? v : JSON.stringify(v);
}
// Plain only when YAML can't read it as anything but a string: a leading digit can parse as a number (`1e3`, `0x1f`,
// `1-2` all do in Bun.YAML), and the keywords as null/booleans. Everything else is quoted.
const yamlSkillItem = (v: string) => (validSkillName(v) && !/^\d/.test(v) && !/^(null|true|false|yes|no|on|off|y|n)$/.test(v) ? v : JSON.stringify(v));
const yamlFlowItem = (v: string) => (/^[A-Za-z0-9_*][A-Za-z0-9_*.-]*$/.test(v) ? v : JSON.stringify(v));

/** The on-disk format (same frontmatter + body as the shipped resumes). */
export function serializeResume(slug: string, r: Omit<ResumeWriteReq, 'slug'>): string {
  return [
    '---',
    `name: ${slug}`,
    `title: ${yamlStr(r.title)}`,
    `description: ${yamlStr(r.description)}`,
    `harness: ${r.harness}`,
    `model: ${r.model == null ? 'null' : yamlStr(r.model)}`,
    `effort: ${r.effort == null ? 'null' : yamlStr(r.effort)}`,
    `can_hire: [${r.can_hire.map(yamlFlowItem).join(', ')}]`,
    `limits: { quiet_minutes: ${r.limits.quiet_minutes}, max_call_minutes: ${r.limits.max_call_minutes} }`,
    ...(r.skills?.length ? [`skills: [${r.skills.map(yamlSkillItem).join(', ')}]`] : []),
    ...(r.helper ? ['helper: true'] : []),
    ...(r.one_shot ? ['one_shot: true'] : []),
    '---',
    r.body.replace(/^\s+/, '').replace(/\s+$/, ''),
    '',
  ].join('\n');
}

/** Shape + field validation of a write request (the catalog check is separate). Returns the normalized request or the error. */
export function validateResumeReq(b: any, opts: { create: boolean }): { value: ResumeWriteReq } | { error: string } {
  if (!b || typeof b !== 'object') return { error: 'body must be a JSON object' };
  if (opts.create) {
    if (typeof b.slug !== 'string' || !SLUG_RE.test(b.slug)) return { error: `slug must match ${SLUG_RE} (lowercase letters, digits, '-', starting with a letter, max 32)` };
  }
  const s = (f: string) => typeof b[f] === 'string';
  if (!s('title') || !b.title.trim()) return { error: 'title must be a non-empty string' };
  if (b.description !== undefined && !s('description')) return { error: 'description must be a string' };
  if (!(HARNESSES as unknown[]).includes(b.harness)) return { error: `harness must be one of ${HARNESSES.join(', ')}` };
  for (const f of ['model', 'effort']) {
    if (b[f] !== undefined && b[f] !== null && (typeof b[f] !== 'string' || /[\s'"]/.test(b[f]))) return { error: `${f} must be a string without spaces or quotes, or null` };
  }
  if (b.can_hire !== undefined && (!Array.isArray(b.can_hire) || !b.can_hire.every((x: unknown) => typeof x === 'string' && (x === '*' || SLUG_RE.test(x))))) {
    return { error: "can_hire must be an array of resume slugs (or ['*'])" };
  }
  if (b.skills !== undefined && (!Array.isArray(b.skills) || !b.skills.every((x: unknown) => typeof x === 'string'))) {
    return { error: 'skills must be an array of skill names (strings)' };
  }
  for (const f of ['helper', 'one_shot']) {
    if (b[f] !== undefined && typeof b[f] !== 'boolean') return { error: `${f} must be true or false` };
  }
  if (b.helper === true && Array.isArray(b.can_hire) && b.can_hire.length) {
    return { error: 'can_hire must be empty for a helper: helpers are leaves and never hire' };
  }
  const lim = b.limits ?? {};
  for (const f of ['quiet_minutes', 'max_call_minutes']) {
    if (lim[f] !== undefined && !(typeof lim[f] === 'number' && Number.isFinite(lim[f]) && lim[f] > 0)) return { error: `limits.${f} must be a positive number` };
  }
  if (b.body !== undefined && !s('body')) return { error: 'body must be a string' };
  if (typeof b.body === 'string' && !b.body.trim()) return { error: 'body (the system prompt) must not be empty' };
  return {
    value: {
      ...(opts.create ? { slug: b.slug } : {}),
      title: b.title.trim(), description: (b.description ?? '').trim(), harness: b.harness,
      model: b.model || null, effort: b.effort || null, can_hire: b.can_hire ?? [],
      limits: { quiet_minutes: lim.quiet_minutes ?? 15, max_call_minutes: lim.max_call_minutes ?? 90 },
      body: b.body ?? '',
      ...(b.skills !== undefined ? { skills: skillNames(b.skills) } : {}),
      ...(b.helper !== undefined ? { helper: b.helper } : {}),
      ...(b.one_shot !== undefined ? { one_shot: b.one_shot } : {}),
    },
  };
}

/**
 * Replace (or insert, or drop when empty) ONLY the `skills:` entry of a resume file's frontmatter; every other byte,
 * comments and blank lines included, is kept. A block-style list under `skills:` is replaced with its continuation lines.
 * New entries go after `can_hire:` (and its continuation lines), else just before the closing `---`.
 * Returns null when the text has no frontmatter.
 */
export function editSkillsLine(text: string, skills: string[]): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/(?<=\n)/); // keep each line's own terminator
  if (!/^---[ \t]*\r?\n?$/.test(lines[0] ?? '')) return null;
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (/^---[ \t]*\r?\n?$/.test(lines[i])) { close = i; break; }
  if (close < 0) return null;
  const isCont = (l: string) => /^[ \t]+\S/.test(l) || /^-[ \t]/.test(l);
  const blockEnd = (start: number) => { let j = start + 1; while (j < close && isCont(lines[j])) j++; return j; };
  const entry = skills.length ? [`skills: [${skills.map(yamlSkillItem).join(', ')}]${eol}`] : [];
  const at = (key: string) => { for (let i = 1; i < close; i++) if (new RegExp(`^${key}[ \\t]*:`).test(lines[i])) return i; return -1; };
  const sk = at('skills');
  if (sk >= 0) {
    const end = blockEnd(sk);
    // the replaced line keeps its terminator style; a last-line `skills:` before `---` always has one
    lines.splice(sk, end - sk, ...entry);
  } else if (entry.length) {
    const ch = at('can_hire');
    const pos = ch >= 0 ? blockEnd(ch) : close;
    if (pos > 0 && !/\n$/.test(lines[pos - 1])) lines[pos - 1] += eol;
    lines.splice(pos, 0, ...entry);
  }
  return lines.join('');
}

export class Resumes {
  constructor(private dirs: string[], private settings: Pick<S, 'quiet_minutes' | 'max_call_minutes'>) {}

  /** Where writes go (the user's resumes dir). */
  get writeDir(): string { return this.dirs[0]; }
  private tombstone(slug: string) { return join(this.writeDir, '.deleted', slug); }
  isTombstoned(slug: string) { return existsSync(this.tombstone(slug)); }

  /** Path of the file that serves `slug` (first dir wins; tombstones hide later dirs), or null. */
  pathOf(slug: string): string | null {
    for (const [i, dir] of this.dirs.entries()) {
      if (i > 0 && this.isTombstoned(slug)) return null;
      const p = join(dir, `${slug}.md`);
      if (existsSync(p)) return p;
    }
    return null;
  }

  isBuiltin(r: R): boolean { return !r.path.startsWith(join(this.writeDir, '/')); }

  /** All resumes; earlier dirs win for the same slug. Sorted by slug. */
  list(): R[] {
    const bySlug = new Map<string, R>();
    for (const [i, dir] of this.dirs.entries()) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith('.md')) continue;
        const slug = f.slice(0, -3);
        if (bySlug.has(slug) || (i > 0 && this.isTombstoned(slug))) continue;
        const p = join(dir, f);
        try { bySlug.set(slug, parseResume(readFileSync(p, 'utf8'), p, this.settings)); } catch { /* skip unreadable */ }
      }
    }
    return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  get(slug: string): R | null {
    const p = this.pathOf(slug);
    if (!p) return null;
    try { return parseResume(readFileSync(p, 'utf8'), p, this.settings); } catch { return null; }
  }

  /** Content hash of the file serving `slug` (null when there is none). */
  hash(slug: string): string | null {
    const p = this.pathOf(slug);
    if (!p) return null;
    try { return hashText(readFileSync(p, 'utf8')); } catch { return null; }
  }

  /** Atomic write of <writeDir>/<slug>.md; clears a tombstone for that slug. */
  write(slug: string, req: Omit<ResumeWriteReq, 'slug'>): R {
    if (!SLUG_RE.test(slug)) throw new Error(`invalid slug ${slug}`);
    mkdirSync(this.writeDir, { recursive: true });
    const path = join(this.writeDir, `${slug}.md`);
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, serializeResume(slug, { ...req, description: templateRuntime(req.description) }));
    renameSync(tmp, path);
    if (this.isTombstoned(slug)) unlinkSync(this.tombstone(slug));
    return this.get(slug)!;
  }

  /**
   * Rewrite a hard-coded runtime in the description line of the user's resumes to ({{runtime}}) (see templateRuntime).
   * Only a single-line `description:` is edited; every other byte stays. Returns the slugs changed.
   */
  templateRuntimeDescriptions(): string[] {
    if (!existsSync(this.writeDir)) return [];
    const changed: string[] = [];
    for (const f of readdirSync(this.writeDir).sort()) {
      if (!f.endsWith('.md')) continue;
      const path = join(this.writeDir, f);
      try {
        const text = readFileSync(path, 'utf8');
        const r = parseResume(text, path, this.settings);
        const next = templateRuntime(r.description);
        if (next === r.description) continue;
        const lines = text.split('\n');
        const i = lines.findIndex((l) => /^description:\s*\S/.test(l));
        if (i < 0 || /^description:\s*[|>]/.test(lines[i])) continue;
        lines[i] = `description: ${yamlStr(next)}`;
        const out = lines.join('\n');
        if (parseResume(out, path, this.settings).description !== next) continue;
        const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
        writeFileSync(tmp, out);
        renameSync(tmp, path);
        changed.push(f.slice(0, -3));
      } catch { /* leave unreadable files alone */ }
    }
    return changed;
  }

  /**
   * Set a resume's skills by editing only its `skills:` line (see editSkillsLine). Synchronous read-modify-write, so
   * two requests can never interleave. A resume served from a later dir (a builtin) is copied to the write dir first.
   * Returns the resume, or null when the slug does not exist; throws when the file has no frontmatter.
   */
  setSkills(slug: string, skills: string[]): R | null {
    const src = this.pathOf(slug);
    if (!src) return null;
    const next = editSkillsLine(readFileSync(src, 'utf8'), skills);
    if (next === null) throw new Error(`resume ${slug} has no frontmatter to hold a skills: list`);
    mkdirSync(this.writeDir, { recursive: true });
    const path = join(this.writeDir, `${slug}.md`);
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, next);
    renameSync(tmp, path);
    if (this.isTombstoned(slug)) unlinkSync(this.tombstone(slug));
    return this.get(slug);
  }

  /**
   * Delete a slug. The user's file is moved to .deleted/<slug>.md.<ts> (recoverable); when a later dir also ships
   * the slug, a tombstone keeps that builtin hidden. Returns false when there was nothing to delete.
   */
  delete(slug: string): boolean {
    const p = this.pathOf(slug);
    if (!p) return false;
    const del = join(this.writeDir, '.deleted');
    mkdirSync(del, { recursive: true });
    const own = join(this.writeDir, `${slug}.md`);
    if (existsSync(own)) renameSync(own, join(del, `${slug}.md.${Date.now()}`));
    if (this.dirs.slice(1).some((d) => existsSync(join(d, `${slug}.md`)))) writeFileSync(this.tombstone(slug), `deleted ${new Date().toISOString()}\n`);
    return true;
  }
}
