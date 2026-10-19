export type Harness = 'claude' | 'codex' | 'opencode';
export type SkillRoot = 'library' | Harness | 'agents' | 'claude-synced' | 'sparrow';
export type SkillStatus = 'managed' | 'sparrow' | 'external' | 'unmanaged' | 'conflict' | 'broken';
export type SkillKind = 'dir' | 'link';

export interface SkillProblem {
  code: string;
  message: string;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  values: Record<string, unknown>;
}

export interface SkillEntry {
  root: SkillRoot;
  name: string;
  path: string;
  kind: SkillKind;
  linkTarget: string | null;
  resolvedTarget: string | null;
  folderHash: string | null;
  frontmatter: SkillFrontmatter | null;
  problems: SkillProblem[];
  readers: Harness[];
  status: SkillStatus;
  conflict: 'identical' | 'diff' | null;
}

export interface ManifestSkill {
  harnesses: Harness[];
  source?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SkillsManifest {
  version: number;
  skills: Record<string, ManifestSkill>;
  [key: string]: unknown;
}

export interface SkillPaths {
  home: string;
  sparrowHome: string;
  library: string;
  backup: string;
  /** Where uploads and import previews are staged (inside the sandbox when SPARROW_SKILLS_HOME is set). */
  staging: string;
  desktopSkills: string;
  roots: Record<SkillRoot, string>;
  externalTargets: string[];
  /** Only the directories Sparrow is allowed to mutate. */
  writeFences: string[];
  sandboxHome: boolean;
}

export type LinkAction =
  | { type: 'create'; root: Harness; name: string; path: string; target: string }
  | { type: 'repair'; root: Harness; name: string; path: string; target: string }
  | { type: 'remove-own-link'; root: Harness; name: string; path: string }
  | { type: 'conflict'; root: Harness; name: string; path: string; reason: string; diff?: string };

export interface GitState {
  available: boolean;
  branch: string | null;
  dirty: string[];
  ahead: number | null;
  behind: number | null;
  remote: string | null;
  error?: string;
}

// ---------------------------------------------------------------- HTTP API shapes (src/server/skills-api.ts, mirrored in web/src/lib/skills.ts)

export type LinkState = 'linked' | 'missing' | 'conflict' | 'broken' | 'off' | 'locked';

/** What one harness root holds for one library skill. `wanted` = the manifest says it should be there. */
export interface HarnessLink {
  harness: Harness;
  wanted: boolean;
  state: LinkState;
  path: string;
  /** Other harnesses that also read this root (Claude's root is read by OpenCode). */
  alsoReadBy: Harness[];
  /** This harness sees the skill through another root without a link of its own. */
  viaRoot: Harness | null;
}

export interface LibrarySkill {
  name: string;
  description: string | null;
  path: string;
  locked: boolean;
  source: 'local' | 'github' | 'sparrow';
  sourceUrl: string | null;
  inManifest: boolean;
  harnesses: Harness[];
  links: HarnessLink[];
  problems: SkillProblem[];
}

export interface SkillPathsView {
  library: string;
  home: string;
  backup: string;
  roots: Record<SkillRoot, string>;
  sandbox: boolean;
}

export interface SkillsState {
  library_missing: boolean;
  /** Why the configured library location is refused (overlaps a harness folder or a migration source), or null. */
  library_problem: string | null;
  library: LibrarySkill[];
  unmanaged: SkillEntry[];
  external: SkillEntry[];
  conflicts: SkillEntry[];
  broken: SkillEntry[];
  git: GitState;
  paths: SkillPathsView;
  warnings: string[];
}

export interface FileNode {
  name: string;
  /** Path relative to the skill folder, `/`-separated. */
  path: string;
  type: 'file' | 'dir' | 'link';
  size?: number;
  children?: FileNode[];
}
