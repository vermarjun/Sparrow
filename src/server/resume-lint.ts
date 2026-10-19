// Doctor check (dogfood D1): a resume description that names a harness or model different from the resume's own
// settings misleads whoever picks a verifier or builder by reading `sparrow resumes`. Conservative on purpose:
// only the three known harness names and models the catalogs list (ids, the part after `provider/`, labels) count,
// `{{…}}` template variables are ignored, and a model is only compared when the resume pins one.
import type { CatalogModel, HarnessCatalog, HarnessName, Resume } from '../shared/types';

const HARNESS_NAMES: { harness: HarnessName; re: RegExp; label: string }[] = [
  { harness: 'claude', re: /\bclaude\b/i, label: 'Claude Code' },
  { harness: 'codex', re: /\bcodex\b/i, label: 'Codex' },
  { harness: 'opencode', re: /\bopen ?code\b/i, label: 'OpenCode' },
];
const CLAUDE_ALIASES = new Set(['opus', 'sonnet', 'haiku']);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const afterSlash = (id: string) => id.slice(id.indexOf('/') + 1);
/** Distinctive model names only: versioned ids ("gpt-6-luna", "kimi-k2") or the Claude aliases, never plain words like "auto". */
const distinctive = (t: string) => t.length >= 4 && (/\d/.test(t) || CLAUDE_ALIASES.has(t.toLowerCase()));

function tokensOf(m: CatalogModel): string[] {
  return [m.id, afterSlash(m.id), m.label, m.resolves_to ?? ''].filter(Boolean);
}

const mentions = (text: string, token: string) => new RegExp(`(?<![\\w.-])${esc(token)}(?![\\w.-])`, 'i').test(text);

export interface DescriptionDrift { slug: string; problems: string[] }

/** Problems for one resume (empty = fine). */
export function descriptionDrift(r: Pick<Resume, 'slug' | 'harness' | 'model' | 'description'>, catalogs: HarnessCatalog[]): string[] {
  if (r.harness === 'fake') return [];
  const text = r.description.replace(/\{\{[^}]*\}\}/g, ' ');
  const problems: string[] = [];

  const named = HARNESS_NAMES.filter((h) => h.re.test(text));
  if (named.length && !named.some((h) => h.harness === r.harness)) {
    problems.push(`names ${named.map((h) => h.label).join(' / ')} but runs on ${HARNESS_NAMES.find((h) => h.harness === r.harness)?.label ?? r.harness}`);
  }

  if (r.model) {
    const own = new Set<string>([r.model, afterSlash(r.model)].map((t) => t.toLowerCase()));
    const all = catalogs.flatMap((c) => c.models);
    for (const m of all.filter((x) => x.id === r.model || x.resolves_to === r.model)) for (const t of tokensOf(m)) own.add(t.toLowerCase());
    const known = new Set<string>();
    for (const m of all) for (const t of tokensOf(m)) if (distinctive(t)) known.add(t);
    const hit = [...known].filter((t) => mentions(text, t));
    if (hit.length && !hit.some((t) => own.has(t.toLowerCase()))) {
      problems.push(`names model ${[...new Set(hit.map((t) => t.toLowerCase()))].slice(0, 3).join(' / ')} but the resume runs ${r.model}`);
    }
  }
  return problems;
}

export function resumeDescriptionDrift(resumes: Pick<Resume, 'slug' | 'harness' | 'model' | 'description'>[], catalogs: HarnessCatalog[]): DescriptionDrift[] {
  return resumes
    .map((r) => ({ slug: r.slug, problems: descriptionDrift(r, catalogs) }))
    .filter((d) => d.problems.length);
}
