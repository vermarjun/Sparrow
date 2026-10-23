import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyResumeFallback } from '../../src/server/resume-fallback';
import { parseResume, renderResumeText } from '../../src/server/resumes';

const DIR = join(import.meta.dir, '../../assets/resumes');
const SETTINGS = { quiet_minutes: 15, max_call_minutes: 90 };
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.md')).sort();
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');
const parse = (text: string, f: string) => parseResume(text, join(DIR, f), SETTINGS);

type Set = Record<'claude' | 'codex' | 'opencode', boolean>;
const sets: Record<string, Set> = {
  all: { claude: true, codex: true, opencode: true },
  'only claude': { claude: true, codex: false, opencode: false },
  'only codex': { claude: false, codex: true, opencode: false },
  'only opencode': { claude: false, codex: false, opencode: true },
  'claude+opencode': { claude: true, codex: false, opencode: true },
  none: { claude: false, codex: false, opencode: false },
};
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

describe('shipped resumes are portable', () => {
  test('all 8 default resumes are present', () => {
    expect(FILES).toEqual(['advisor.md', 'builder-codex.md', 'builder.md', 'deckhand.md', 'presenter.md', 'researcher.md', 'sub-captain.md', 'verifier.md']);
  });
  test('claude resumes use aliases only; codex/opencode resumes name no model', () => {
    for (const f of FILES) {
      const r = parse(read(f), f);
      if (r.harness === 'claude') expect(['opus', 'sonnet', 'haiku']).toContain(r.model as string);
      else expect(r.model).toBeNull();
    }
  });
  test('descriptions and bodies render sensibly with the harness default model', () => {
    for (const f of FILES.filter((x) => /builder-codex|verifier|researcher|presenter/.test(x))) {
      const r = parse(read(f), f);
      const d = renderResumeText(r.description, r);
      expect(d).not.toContain('{{');
      expect(d).toContain('harness default');
      expect(renderResumeText(r.body, r)).not.toMatch(/undefined|null/);
    }
  });
});

describe('applyResumeFallback: every default resume x every installed set', () => {
  for (const [label, installed] of Object.entries(sets)) {
    for (const f of FILES) {
      test(`${f} with ${label}`, () => {
        const src = read(f);
        const orig = parse(src, f);
        const out = applyResumeFallback(src, installed);
        const r = parse(out.text, f);
        if (installed[orig.harness as 'claude']) {
          expect(out.text).toBe(src);
          expect(out.note).toBeUndefined();
          return;
        }
        const target = (['claude', 'codex', 'opencode'] as const).filter((h) => h !== orig.harness).find((h) => installed[h]);
        if (!target) {
          expect(out.text).toBe(src);
          expect(out.note).toMatch(/not installed/);
          return;
        }
        expect(r.harness).toBe(target);
        expect(out.note).toContain(`${orig.slug}: ${orig.harness} not installed -> seeded on ${target}`);
        // body and every non-runtime field survive
        expect(r.body).toBe(orig.body);
        expect(r.description).toBe(orig.description);
        expect(r.can_hire).toEqual(orig.can_hire);
        expect(r.limits).toEqual(orig.limits);
        expect(r.skills).toEqual(orig.skills);
        expect(!!r.helper).toBe(!!orig.helper);
        expect(!!r.one_shot).toBe(!!orig.one_shot);
        if (target === 'claude') {
          expect(['opus', 'sonnet', 'haiku']).toContain(r.model as string);
          expect(r.model).toBe(orig.harness !== 'claude' ? 'sonnet' : orig.model);
          if (r.effort) expect(CLAUDE_EFFORTS).toContain(r.effort);
        } else {
          expect(r.model).toBeNull();
          if (target === 'codex' && r.effort) expect(CODEX_EFFORTS).toContain(r.effort);
          if (target === 'opencode') expect(r.effort).toBeNull();
        }
        // the rewrite is idempotent
        expect(applyResumeFallback(out.text, installed).text).toBe(out.text);
      });
    }
  }
});

describe('applyResumeFallback details', () => {
  test('verifier on only-claude: sonnet, effort kept, titled note', () => {
    const out = applyResumeFallback(read('verifier.md'), sets['only claude']);
    expect(out.note).toBe('verifier: codex not installed -> seeded on claude · sonnet');
    expect(out.text).toMatch(/^harness: claude$/m);
    expect(out.text).toMatch(/^model: sonnet$/m);
    expect(out.text).toMatch(/^effort: high$/m);
  });
  test('builder-codex title stops saying Codex when seeded on claude', () => {
    expect(applyResumeFallback(read('builder-codex.md'), sets['only claude']).text).toMatch(/^title: Builder \(Claude\)$/m);
  });
  test('claude resume with claude missing: codex preferred, model omitted, max clamps to xhigh; opencode drops effort', () => {
    const src = ['---', 'name: x', 'harness: claude', 'model: opus', 'effort: max', '---', 'body {{runtime}}', ''].join('\n');
    const toCodex = applyResumeFallback(src, { claude: false, codex: true, opencode: true });
    expect(toCodex.text).toBe(['---', 'name: x', 'harness: codex', 'effort: xhigh', '---', 'body {{runtime}}', ''].join('\n'));
    const toOc = applyResumeFallback(src, { claude: false, codex: false, opencode: true });
    expect(toOc.text).toBe(['---', 'name: x', 'harness: opencode', '---', 'body {{runtime}}', ''].join('\n'));
    expect(toOc.note).toBe('x: claude not installed -> seeded on opencode · harness default model');
  });
  test('codex -> opencode keeps nothing model-specific; haiku/opus aliases survive a claude target only when the resume was claude', () => {
    const src = ['---', 'name: y', 'harness: opencode', 'model: opencode-go/glm-5.3', '---', 'b', ''].join('\n');
    const out = applyResumeFallback(src, { claude: true, codex: true, opencode: false });
    expect(out.text).toContain('harness: claude');
    expect(out.text).toContain('model: sonnet');
  });
  test('quoted values, CRLF files and a missing harness line (parser default: claude) are handled', () => {
    const crlf = '---\r\nname: z\r\nharness: "codex"\r\nmodel: \'gpt-x\'\r\neffort: high\r\n---\r\nbody\r\n';
    const out = applyResumeFallback(crlf, sets['only claude']);
    expect(out.text).toBe('---\r\nname: z\r\nharness: claude\r\nmodel: sonnet\r\neffort: high\r\n---\r\nbody\r\n');
    const noHarness = '---\nname: w\nmodel: opus\n---\nb\n';
    const o2 = applyResumeFallback(noHarness, { claude: false, codex: true, opencode: false });
    expect(o2.text).toBe('---\nname: w\nharness: codex\n---\nb\n');
  });
  test('fake harness, a text with no frontmatter, and an installed harness are returned untouched', () => {
    const fake = '---\nname: f\nharness: fake\n---\nb\n';
    expect(applyResumeFallback(fake, sets.none)).toEqual({ text: fake });
    expect(applyResumeFallback('just text', sets.none)).toEqual({ text: 'just text' });
    expect(applyResumeFallback(read('builder.md'), sets['only claude']).text).toBe(read('builder.md'));
  });
  test('nothing installed: unchanged with a note', () => {
    const out = applyResumeFallback(read('verifier.md'), sets.none);
    expect(out.text).toBe(read('verifier.md'));
    expect(out.note).toBe('verifier: codex not installed and no other harness found; left as is');
  });
});
