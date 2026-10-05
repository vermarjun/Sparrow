// Resume (role card) loading: RESUMES_DIR/*.md first, then assets/resumes/*.md for slugs the user doesn't have.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { HarnessName as H, Resume as R } from '../shared/types';
import type { Settings as S } from '../shared/config';

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
  };
}

export class Resumes {
  constructor(private dirs: string[], private settings: Pick<S, 'quiet_minutes' | 'max_call_minutes'>) {}

  /** All resumes; earlier dirs win for the same slug. Sorted by slug. */
  list(): R[] {
    const bySlug = new Map<string, R>();
    for (const dir of this.dirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith('.md')) continue;
        const slug = f.slice(0, -3);
        if (bySlug.has(slug)) continue;
        const p = join(dir, f);
        try { bySlug.set(slug, parseResume(readFileSync(p, 'utf8'), p, this.settings)); } catch { /* skip unreadable */ }
      }
    }
    return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  get(slug: string): R | null {
    for (const dir of this.dirs) {
      const p = join(dir, `${slug}.md`);
      if (existsSync(p)) {
        try { return parseResume(readFileSync(p, 'utf8'), p, this.settings); } catch { return null; }
      }
    }
    return null;
  }
}
