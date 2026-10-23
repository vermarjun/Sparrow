// Builds a demo HOME under <repo>/.sandbox/home (never anywhere else):
// a git library with a bare origin, a managed link, an unmanaged folder, External entries, two conflicts and a broken link.
//   bun scripts/skills-demo-fixture.ts
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const SANDBOX = join(REPO, '.sandbox');
const home = resolve(process.argv[2] ?? join(SANDBOX, 'home'));
if (!home.startsWith(SANDBOX + sep)) throw new Error(`refusing to build a fixture outside ${SANDBOX}: ${home}`);

const run = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`${args.join(' ')}: ${p.stderr.toString()}`);
};
const git = (cwd: string, ...args: string[]) => run(cwd, 'git', ...args);

if (existsSync(home)) run(REPO, 'trash', home);
const origin = join(SANDBOX, 'origin.git');
if (existsSync(origin)) run(REPO, 'trash', origin);

function skill(dir: string, name: string, description: string, body: string, extra: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

const lib = join(home, 'Skills');
mkdirSync(lib, { recursive: true });
git(lib, 'init', '-q', '-b', 'main');
git(lib, 'config', 'user.email', 'demo@example.com');
git(lib, 'config', 'user.name', 'Demo');
git(SANDBOX, 'init', '-q', '--bare', '-b', 'main', origin);

skill(join(lib, 'write-like-a-human'), 'write-like-a-human', 'De-AI voice pass for any prose. Cuts filler, hedges and the usual tells.',
  '\n# Write like a human\n\nUse this skill to edit prose so it reads as written by a person.\n\n## Steps\n\n1. Read the draft aloud.\n2. Cut filler: *very*, *really*, *in order to*.\n3. Replace stock phrases with a concrete detail.\n\n> Short sentences carry weight.\n\n| Tell | Fix |\n|---|---|\n| "delve" | "dig into" |\n| "tapestry" | name the thing |\n',
  { 'references/tells.md': '# Tells\n\n- delve\n- tapestry\n', 'scripts/check.sh': '#!/bin/sh\necho checking\n' });
skill(join(lib, 'component-design'), 'component-design', 'Routes UI work to component libraries and design tokens before writing custom markup.', '\n# Component design\n\nPrefer the existing component library. Check `components/ui` first.\n');
skill(join(lib, 'react-best-practices'), 'react-best-practices', 'React and Next.js performance rules from Vercel Engineering.', '\n# React best practices\n\n1. Avoid waterfalls.\n2. Keep bundles small.\n');
skill(join(lib, 'release-notes'), 'release-notes', 'Release note orchestrator: tracks changes, drafts, and publication.', '\n# release-notes\n\nGroups changes into release notes.\n');
skill(join(lib, 'web-design-guidelines'), 'web-design-guidelines', 'Review UI code against the Web Interface Guidelines.', '\n# Web design guidelines\n\nCheck accessibility, focus states and motion.\n');
writeFileSync(join(lib, 'skills.json'), JSON.stringify({
  version: 1,
  skills: {
    'write-like-a-human': { harnesses: ['claude', 'codex'] },
    'component-design': { harnesses: ['claude'] },
    'react-best-practices': {
      harnesses: ['claude'],
      source: { source: 'vercel-labs/agent-skills', sourceType: 'github', sourceUrl: 'https://github.com/vercel-labs/agent-skills.git', skillPath: 'skills/react-best-practices/SKILL.md', installedAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z' },
    },
    'release-notes': { harnesses: [] },
    'web-design-guidelines': { harnesses: ['claude', 'opencode'] },
  },
}, null, 2) + '\n');
writeFileSync(join(lib, '.gitignore'), '.DS_Store\n.*-tmp\n');
git(lib, 'add', '--all');
git(lib, 'commit', '-q', '-m', 'seed library');
git(lib, 'remote', 'add', 'origin', origin);
git(lib, 'push', '-q', '-u', 'origin', 'main');
// history on one skill, then two unpushed commits and one uncommitted change: "1 changed · 2 unpushed"
writeFileSync(join(lib, 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Release note orchestrator: tracks changes, drafts, and publication.\n---\n\n# release-notes\n\nGroups changes into release notes.\n\nAdded a publication reminder step.\n');
git(lib, 'add', '--all');
git(lib, 'commit', '-q', '-m', 'release-notes: publication reminders');
writeFileSync(join(lib, 'component-design', 'SKILL.md'), '---\nname: component-design\ndescription: Routes UI work to component libraries and design tokens before writing custom markup.\n---\n\n# Component design\n\nPrefer the existing component library. Check `components/ui` first.\n\nThen check the design tokens.\n');
git(lib, 'add', '--all');
git(lib, 'commit', '-q', '-m', 'component-design: mention tokens');
writeFileSync(join(lib, 'write-like-a-human', 'references', 'tells.md'), '# Tells\n\n- delve\n- tapestry\n- landscape\n');

const link = (target: string, path: string) => { mkdirSync(join(path, '..'), { recursive: true }); symlinkSync(target, path, 'dir'); };
const claude = join(home, '.claude', 'skills');
const codex = join(home, '.codex', 'skills');
const opencode = join(home, '.config', 'opencode', 'skills');
// managed links (match the manifest)
for (const n of ['write-like-a-human', 'component-design', 'react-best-practices', 'web-design-guidelines']) link(join(lib, n), join(claude, n));
link(join(lib, 'write-like-a-human'), join(codex, 'write-like-a-human'));
// web-design-guidelines wants opencode too but has no link there yet ("missing link")
// unmanaged real folders
skill(join(claude, 'meeting-notes'), 'meeting-notes', 'Turns a transcript into decisions and action items.', '\n# Meeting notes\n\nSummarise decisions first.\n');
skill(join(codex, 'sql-review'), 'sql-review', 'Reviews SQL for locking and index problems.', '\n# SQL review\n\nCheck for missing indexes.\n');
// External: other tools
const agents = join(home, '.agents', 'skills');
skill(join(agents, 'aws-lambda'), 'aws-lambda', 'Build and debug AWS Lambda functions.', '\n# AWS Lambda\n\nUse SAM for local invocation.\n');
skill(join(agents, 'aws-cdk'), 'aws-cdk', 'Write CDK stacks in TypeScript.', '\n# AWS CDK\n\nOne stack per service.\n');
skill(join(claude, 'synced', 'claude-ai', 'brand-voice'), 'brand-voice', 'Synced from claude.ai: the team brand voice.', '\n# Brand voice\n\nPlain, warm, direct.\n');
// conflicts: a differing copy and an identical copy
skill(join(codex, 'component-design'), 'component-design', 'Routes UI work to component libraries and design tokens before writing custom markup.', '\n# Component design\n\nPrefer the existing component library. Always check `components/ui` first.\n\nNever hand-roll a button.\n', { 'notes.md': 'local notes\n' });
skill(join(opencode, 'release-notes'), 'release-notes', 'Release note orchestrator: tracks changes, drafts, and publication.', '\n# release-notes\n\nGroups changes into release notes.\n\nAdded a publication reminder step.\n');
// broken link
link(join(home, 'Desktop', 'Skills', 'retired-skill'), join(claude, 'retired-skill'));
console.log(`fixture ready: ${home}\n  library ${lib}\n  origin  ${origin}`);
