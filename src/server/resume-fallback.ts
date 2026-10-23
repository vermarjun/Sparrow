// Seeding fallback (pure, no fs): a resume whose harness is not installed is rewritten onto one that is, so someone
// with only Claude Code (or only Codex, or only OpenCode) can hire every default role. Only frontmatter lines change;
// the body is kept ({{runtime}} / {{harness}} / {{model}} render "harness default" for an omitted model).
type H = 'claude' | 'codex' | 'opencode';
const REAL: H[] = ['claude', 'codex', 'opencode'];
const NAME: Record<H, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

// Claude Code's `--effort` levels and the ones Codex's `model_reasoning_effort` accepts on every model. OpenCode's
// variants differ per model, so an effort is dropped there (the model's own default applies).
const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'];
const EFFORT_RANK = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_MAX = 'xhigh';

/** Target harness: prefer claude, then codex, then opencode, never the harness that is missing. */
function pickTarget(from: H, installed: Record<H, boolean>): H | null {
  return REAL.find((h) => h !== from && installed[h]) ?? null;
}

function effortFor(target: H, effort: string | null): string | null {
  if (!effort || target === 'opencode') return null;
  const i = EFFORT_RANK.indexOf(effort);
  if (i < 0) return null;
  return target === 'codex' && i > EFFORT_RANK.indexOf(CODEX_MAX) ? CODEX_MAX : effort;
}

const unq = (v: string) => v.trim().replace(/^["'](.*)["']$/, '$1');

/** `Builder (Codex)` -> `Builder (Claude)`: a title that names the old harness must not lie about the new one. */
function retitle(title: string, from: H, to: H): string {
  return title.replace(new RegExp(`\\((\\s*)${NAME[from]}(\\s*)\\)`, 'i'), `($1${NAME[to]}$2)`);
}

export function applyResumeFallback(text: string, installed: Record<H, boolean>): { text: string; note?: string } {
  const m = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))([\s\S]*)$/);
  if (!m) return { text };
  const eol = m[1].endsWith('\r\n') ? '\r\n' : '\n';
  const lines = m[2].split(/\r?\n/);
  const find = (key: string) => lines.findIndex((l) => new RegExp(`^${key}[ \\t]*:`).test(l));
  const val = (i: number) => (i < 0 ? null : unq(lines[i].replace(/^[^:]*:/, '').replace(/\s+#.*$/, '')) || null);

  const hi = find('harness');
  const raw = val(hi);
  // parseResume treats a missing or unknown harness as claude; `fake` is for tests and never rewritten.
  const from: H | 'fake' = raw === 'fake' ? 'fake' : (REAL as string[]).includes(raw ?? '') ? (raw as H) : 'claude';
  if (from === 'fake' || installed[from]) return { text };
  const slug = val(find('name')) ?? 'resume';
  const to = pickTarget(from, installed);
  if (!to) return { text, note: `${slug}: ${from} not installed and no other harness found; left as is` };

  const model = val(find('model'));
  const effort = effortFor(to, val(find('effort')));
  // Claude: keep a claude alias the resume already used (haiku for cheap roles, opus for senior ones), else sonnet.
  const newModel = to === 'claude' ? (model && CLAUDE_ALIASES.includes(model) ? model : 'sonnet') : null;

  const set = (key: string, value: string | null, after: string) => {
    const i = find(key);
    if (value === null) { if (i >= 0) lines.splice(i, 1); return; }
    if (i >= 0) lines[i] = `${key}: ${value}`;
    else {
      const a = find(after);
      lines.splice(a >= 0 ? a + 1 : lines.length, 0, `${key}: ${value}`);
    }
  };
  if (hi >= 0) lines[hi] = `harness: ${to}`;
  else lines.splice(Math.max(find('name') + 1, 0), 0, `harness: ${to}`);
  set('model', newModel, 'harness');
  set('effort', effort, newModel ? 'model' : 'harness');
  const ti = find('title');
  if (ti >= 0) lines[ti] = retitle(lines[ti], from, to);

  const note = `${slug}: ${from} not installed -> seeded on ${to}${newModel ? ` · ${newModel}` : ' · harness default model'}`;
  return { text: m[1] + lines.join(eol) + m[3] + m[4], note };
}
