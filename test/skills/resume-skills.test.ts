import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResumeWriteReq } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/config';
import { editSkillsLine, parseResume, Resumes, serializeResume, validateResumeReq } from '../../src/server/resumes';

const base: Omit<ResumeWriteReq, 'slug'> = { title: 'T', description: 'd', harness: 'claude', model: null, effort: null, can_hire: [], limits: { quiet_minutes: 15, max_call_minutes: 90 }, body: 'You are T.' };

describe('resume skills:', () => {
  test('parses a flow list; absent → []; duplicates collapse; invalid names are kept', () => {
    const p = (fm: string) => parseResume(`---\nname: t\n${fm}---\nbody\n`, '/x/t.md', DEFAULT_SETTINGS);
    expect(p('skills: [alpha, beta]\n').skills).toEqual(['alpha', 'beta']);
    expect(p('').skills).toEqual([]);
    expect(p('skills: [alpha, alpha, "Bad Name", ../x]\n').skills).toEqual(['alpha', 'Bad Name', '../x']);
    expect(p('skills:\n  - alpha\n  - beta\n').skills).toEqual(['alpha', 'beta']);
    expect(p('skills: []\n').skills).toEqual([]);
  });

  test('serialize omits the line when empty and round-trips awkward names', () => {
    expect(serializeResume('t', base)).not.toContain('skills');
    expect(serializeResume('t', { ...base, skills: [] })).not.toContain('skills');
    const names = ['alpha', 'beta-2', '123', 'true', 'Bad Name', '../x', 'quo"te'];
    const text = serializeResume('t', { ...base, skills: names });
    expect(text).toContain('skills: [alpha, beta-2, "123", "true", "Bad Name", "../x", "quo\\"te"]');
    expect(parseResume(text, '/x/t.md', DEFAULT_SETTINGS).skills).toEqual(['alpha', 'beta-2', '123', 'true', 'Bad Name', '../x', 'quo"te']);
  });

  test('number-looking valid names survive serialize and the matrix line edit (1-2, 1e3, 0x1f, 0o17, 12-34)', () => {
    const names = ['1-2', '1e3', '0x1f', '0o17', '12-34', '9lives', 'alpha'];
    const text = serializeResume('t', { ...base, skills: names });
    expect(parseResume(text, '/x/t.md', DEFAULT_SETTINGS).skills).toEqual(names);
    const edited = editSkillsLine(serializeResume('t', base), names);
    expect(parseResume(edited!, "/x/t.md", DEFAULT_SETTINGS).skills).toEqual(names);
  });

  test('validateResumeReq accepts and normalizes skills, rejects non-string lists', () => {
    const ok = validateResumeReq({ ...base, skills: [' alpha ', 'alpha', 'beta'] }, { create: false });
    expect('value' in ok && ok.value.skills).toEqual(['alpha', 'beta']);
    const none = validateResumeReq({ ...base }, { create: false });
    expect('value' in none && 'skills' in none.value).toBe(false);
    expect(validateResumeReq({ ...base, skills: 'alpha' }, { create: false })).toEqual({ error: 'skills must be an array of skill names (strings)' });
    expect(validateResumeReq({ ...base, skills: [1] }, { create: false })).toEqual({ error: 'skills must be an array of skill names (strings)' });
  });

  test('a resume save does not drop skills: (write → get → write → file)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-resume-skills-'));
    const rs = new Resumes([dir], DEFAULT_SETTINGS);
    const first = rs.write('t', { ...base, skills: ['alpha', 'beta'] });
    expect(first.skills).toEqual(['alpha', 'beta']);
    // what the UI/API does on edit: take the current resume, change a field, write it back with its skills
    const { slug: _s, path: _p, ...rest } = rs.get('t')!;
    rs.write('t', { ...rest, title: 'Renamed' });
    const again = rs.get('t')!;
    expect(again.title).toBe('Renamed');
    expect(again.skills).toEqual(['alpha', 'beta']);
    expect(readFileSync(join(dir, 't.md'), 'utf8')).toContain('skills: [alpha, beta]');
  });
});

describe('editSkillsLine (touches only the skills: entry)', () => {
  const base = ['---', 'name: t', '# keep me: a comment', 'title: T', 'can_hire: [a, b]  # trailing', '', 'limits: { quiet_minutes: 1, max_call_minutes: 2 }', '---', 'Body', ''].join('\n');
  const lines = (t: string) => t.split('\n');

  test('inserts after can_hire when absent; everything else byte-identical', () => {
    const out = editSkillsLine(base, ['alpha', 'beta'])!;
    expect(out).toBe(base.replace('can_hire: [a, b]  # trailing\n', 'can_hire: [a, b]  # trailing\nskills: [alpha, beta]\n'));
    expect(parseResume(out, '/x/t.md', DEFAULT_SETTINGS).skills).toEqual(['alpha', 'beta']);
  });
  test('replaces an existing flow line, removes it when empty, and round-trips back byte-for-byte', () => {
    const withSkills = editSkillsLine(base, ['alpha'])!;
    expect(editSkillsLine(withSkills!, ['alpha', 'beta'])).toBe(withSkills!.replace('skills: [alpha]', 'skills: [alpha, beta]'));
    expect(editSkillsLine(withSkills!, [])).toBe(base);
  });
  test('replaces a block-style list with its items; no can_hire → before the closing ---', () => {
    const block = ['---', 'name: t', '# c', 'skills:', '  - alpha', '  - beta', 'title: T', '---', 'Body', ''].join('\n');
    const out = editSkillsLine(block, ['gamma'])!;
    expect(out).toBe(['---', 'name: t', '# c', 'skills: [gamma]', 'title: T', '---', 'Body', ''].join('\n'));
    expect(editSkillsLine(['---', 'name: t', '# c', '---', 'B', ''].join('\n'), ['x'])).toBe(['---', 'name: t', '# c', 'skills: [x]', '---', 'B', ''].join('\n'));
  });
  test('CRLF files keep CRLF; no frontmatter → null', () => {
    const crlf = base.replace(/\n/g, '\r\n');
    const out = editSkillsLine(crlf, ['alpha'])!;
    expect(out.replace(/\r\n/g, '\n')).toBe(editSkillsLine(base, ['alpha'])!);
    expect(out.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
    expect(editSkillsLine('just a body\n', ['a'])).toBeNull();
    expect(lines(base).length).toBeGreaterThan(5);
  });
  test('Resumes.setSkills copies a builtin to the write dir with its comments, and returns null for an unknown slug', () => {
    const user = mkdtempSync(join(tmpdir(), 'sp-rs-user-')), builtin = mkdtempSync(join(tmpdir(), 'sp-rs-builtin-'));
    require('node:fs').writeFileSync(join(builtin, 't.md'), base);
    const rs = new Resumes([user, builtin], DEFAULT_SETTINGS);
    expect(rs.setSkills('nope', ['a'])).toBeNull();
    expect(rs.setSkills('t', ['alpha'])!.skills).toEqual(['alpha']);
    expect(readFileSync(join(user, 't.md'), 'utf8')).toBe(editSkillsLine(base, ['alpha'])!);
    expect(readFileSync(join(builtin, 't.md'), 'utf8')).toBe(base); // the shipped file is untouched
  });
});
