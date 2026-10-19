import type { SkillFrontmatter, SkillProblem } from './types';

/** Agent Skills spec name: 1–64 lowercase alphanumerics separated by single hyphens. */
/** Sparrow's own skills: shipped in assets/skills, always on for every agent, never adopted/created/imported. */
export const SPARROW_SKILLS = ['sparrow-worker', 'sparrow-captain'] as const;
export const isReservedSkillName = (name: string): boolean => (SPARROW_SKILLS as readonly string[]).includes(name);

export function validSkillName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export interface ParsedFrontmatter {
  frontmatter: SkillFrontmatter | null;
  problems: SkillProblem[];
  body: string;
}

function scalar(raw: string): unknown {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?(?:\d+|\d+\.\d+)$/.test(value)) return Number(value);
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { return JSON.parse(value); } catch {}
  }
  return value;
}

/** A recovery parser for common key/value frontmatter, preserving nested keys as objects. */
function lenientMap(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let current: string | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (top) {
      current = top[1]!;
      result[current] = top[2] ? scalar(top[2]) : {};
      continue;
    }
    const nested = line.match(/^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (nested && current) {
      const parent = result[current];
      if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
        (parent as Record<string, unknown>)[nested[1]!] = nested[2] ? scalar(nested[2]) : {};
      }
    }
  }
  return result;
}

function specProblems(values: Record<string, unknown>, folderName?: string): SkillProblem[] {
  const problems: SkillProblem[] = [];
  const name = values.name;
  if (typeof name !== 'string') problems.push({ code: 'name-missing', message: 'name must be a string' });
  else {
    if (name.length < 1 || name.length > 64) problems.push({ code: 'name-length', message: 'name must be 1–64 characters' });
    if (name.length <= 64 && !validSkillName(name)) problems.push({ code: 'name-format', message: 'name must use lowercase letters, digits, and single hyphens only' });
    if (folderName !== undefined && name !== folderName) problems.push({ code: 'name-folder', message: `name "${name}" does not match folder "${folderName}"` });
  }
  const description = values.description;
  if (typeof description !== 'string') problems.push({ code: 'description-missing', message: 'description must be a string' });
  else if (description.length < 1 || description.length > 1024) problems.push({ code: 'description-length', message: 'description must be 1–1024 characters' });
  if (values.compatibility !== undefined) {
    if (typeof values.compatibility !== 'string') problems.push({ code: 'compatibility-type', message: 'compatibility must be a string' });
    else if (values.compatibility.length > 500) problems.push({ code: 'compatibility-length', message: 'compatibility must be at most 500 characters' });
  }
  if (values.metadata !== undefined) {
    const metadata = values.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || Object.values(metadata).some((value) => typeof value !== 'string')) {
      problems.push({ code: 'metadata-type', message: 'metadata must be a map of string keys to string values' });
    }
  }
  return problems;
}

export function validateFrontmatter(values: Record<string, unknown>, folderName?: string): SkillProblem[] {
  return specProblems(values, folderName);
}

export function parseSkillFrontmatter(contents: string, folderName?: string): ParsedFrontmatter {
  const normalized = contents.replace(/^\uFEFF/, '');
  const start = normalized.match(/^---\s*\r?\n/);
  if (!start) return { frontmatter: null, problems: [{ code: 'frontmatter-missing', message: 'SKILL.md has no YAML frontmatter' }], body: normalized };
  const rest = normalized.slice(start[0].length);
  const end = /\r?\n---(?:\s*\r?\n|\s*$)/.exec(rest);
  if (!end) return { frontmatter: null, problems: [{ code: 'frontmatter-unclosed', message: 'YAML frontmatter is not closed' }], body: rest };
  const yaml = rest.slice(0, end.index);
  const body = rest.slice(end.index + end[0].length);
  let values: Record<string, unknown>;
  const problems: SkillProblem[] = [];
  try {
    const parsed = Bun.YAML.parse(yaml);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('frontmatter must be a YAML mapping');
    values = parsed as Record<string, unknown>;
  } catch (error) {
    problems.push({ code: 'yaml', message: `strict YAML parse failed: ${(error as Error).message}` });
    values = lenientMap(yaml);
  }
  problems.push(...specProblems(values, folderName));
  const frontmatter: SkillFrontmatter = {
    ...(typeof values.name === 'string' ? { name: values.name } : {}),
    ...(typeof values.description === 'string' ? { description: values.description } : {}),
    values,
  };
  return { frontmatter, problems, body };
}

export const parse = parseSkillFrontmatter;
