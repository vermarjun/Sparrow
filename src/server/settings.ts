// Live settings (the web Settings page): GET/PUT /api/settings. Values persist in <SPARROW_HOME>/config.json, which keeps
// every key it already had (skills_dir and anything unknown); a SPARROW_SETTINGS env key wins and is read-only here.
// Every change applies at once: the settings object is shared by reference with Core, Resumes and the doctor, and
// subscribers re-arm what was fixed at start (watchdog / snapshot timers) or act on it (dequeue after max_running grows).
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '../shared/config';
import type { SettingField, SettingKey, SettingsView, SettingsWriteReq } from '../shared/types';
import { HttpError } from './core';

type Meta = Omit<SettingField, 'key' | 'default' | 'value' | 'saved' | 'env_override'>;

export const SETTING_FIELDS: Record<SettingKey, Meta> = {
  max_running: {
    group: 'Capacity', label: 'Running slots', unit: 'agents', min: 1, max: 50,
    help: 'Agents that may work at the same time across all projects. More hires wait in the queue. An agent parked on sparrow wait or ask does not hold a slot.',
  },
  max_depth: {
    group: 'Capacity', label: 'Depth limit', unit: 'levels', min: 1, max: 10,
    help: 'How deep the hiring tree may grow; you are level 0. 3 = you → sub-captain → builder → helper (deckhand / advisor).',
  },
  quiet_minutes: {
    group: 'Call limits', label: 'Quiet nudge', unit: 'minutes', min: 1, max: 240,
    help: 'Default for resumes without their own limit: a working agent silent this long is nudged to post an update.',
  },
  max_call_minutes: {
    group: 'Call limits', label: 'Long call notice', unit: 'minutes', min: 1, max: 1440,
    help: 'Default for resumes without their own limit: the parent is told when one call runs this long.',
  },
  max_nudges: {
    group: 'Call limits', label: 'Report reminders', unit: 'per call', min: 0, max: 10,
    help: 'Reminders when an agent stops without reporting; after these the call ends as unreported.',
  },
  max_restarts: {
    group: 'Call limits', label: 'Crash restarts', unit: 'per call', min: 0, max: 10,
    help: 'Automatic restarts after a crash before the agent is marked crashed.',
  },
  provider_error_threshold: {
    group: 'Provider health', label: 'Errors before degraded', unit: 'errors', min: 1, max: 100,
    help: 'Consecutive provider errors that mark a harness + provider as degraded (shown on resumes; never blocks hiring).',
  },
  provider_error_window_minutes: {
    group: 'Provider health', label: 'Error window', unit: 'minutes', min: 1, max: 1440,
    help: 'The errors above must fall within this many minutes.',
  },
  close_grace_ms: {
    group: 'Timing', label: 'Window close grace', unit: 'ms', min: 0, max: 120_000,
    help: 'Delay between a report (done / ask / wait) and closing the agent\'s tmux window.',
  },
  watchdog_ms: {
    group: 'Timing', label: 'Watchdog interval', unit: 'ms', min: 500, max: 60_000,
    help: 'How often the server checks that working agents are alive and within their limits.',
  },
  snapshot_ms: {
    group: 'Timing', label: 'Screen snapshot interval', unit: 'ms', min: 1000, max: 600_000,
    help: 'How often the screens of working agents are captured for the web UI.',
  },
  fresh_fallback_ms: {
    group: 'Timing', label: 'Fresh-session fallback', unit: 'ms', min: 0, max: 600_000,
    help: 'A resumed call that dies within this window restarts with a fresh session instead.',
  },
  doctor_timeout_ms: {
    group: 'Timing', label: 'Doctor round-trip timeout', unit: 'ms', min: 5000, max: 600_000,
    help: 'Per-harness cap for the doctor\'s live hire-and-report check.',
  },
};

export const SETTING_KEYS = Object.keys(SETTING_FIELDS) as SettingKey[];
const DOCTOR_HARNESSES = ['claude', 'codex', 'opencode'] as const;
type DoctorHarness = (typeof DOCTOR_HARNESSES)[number];

const readJson = (file: string): Record<string, unknown> => {
  if (!existsSync(file)) return {};
  const v = JSON.parse(readFileSync(file, 'utf8'));
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
};

export class SettingsService {
  private listeners: ((changed: (keyof Settings)[]) => void)[] = [];

  constructor(
    readonly settings: Settings,
    readonly file: string,
    private env: string | undefined = process.env.SPARROW_SETTINGS,
  ) {}

  /** Keys set by SPARROW_SETTINGS (tests, sandboxes): they win over config.json, so the page shows them read-only. */
  envKeys(): Set<string> {
    if (!this.env) return new Set();
    try { return new Set(Object.keys(JSON.parse(this.env) ?? {})); } catch { return new Set(); }
  }

  onChange(fn: (changed: (keyof Settings)[]) => void) { this.listeners.push(fn); }

  view(): SettingsView {
    let saved: Record<string, unknown> = {};
    try { saved = readJson(this.file); } catch { /* unreadable: show effective values, saved = false */ }
    const env = this.envKeys();
    return {
      fields: SETTING_KEYS.map((key) => ({
        key, ...SETTING_FIELDS[key], default: DEFAULT_SETTINGS[key], value: this.settings[key],
        saved: Object.hasOwn(saved, key), env_override: env.has(key),
      })),
      doctor_models: { ...(this.settings.doctor_models ?? {}) },
      file: this.file,
    };
  }

  /** Validate everything first, then write config.json atomically, then apply. All or nothing. */
  update(req: SettingsWriteReq): SettingsView {
    if (!req || typeof req !== 'object') throw new HttpError(400, 'body must be {values?, doctor_models?}');
    const values = req.values ?? {};
    if (typeof values !== 'object' || Array.isArray(values)) throw new HttpError(400, 'values must be an object of setting: number | null');
    const env = this.envKeys();
    const sets: Partial<Record<SettingKey, number>> = {};
    const resets: SettingKey[] = [];
    for (const [k, v] of Object.entries(values)) {
      if (!(SETTING_KEYS as string[]).includes(k)) throw new HttpError(400, `${k}: unknown setting. Known: ${SETTING_KEYS.join(', ')}`);
      const key = k as SettingKey;
      const f = SETTING_FIELDS[key];
      if (env.has(key)) throw new HttpError(409, `${key}: set by the SPARROW_SETTINGS environment variable of this server; change it there.`);
      if (v === null) { resets.push(key); continue; }
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new HttpError(400, `${key}: must be a whole number (${f.unit})`);
      if (v < f.min || v > f.max) throw new HttpError(400, `${key}: must be between ${f.min} and ${f.max} ${f.unit}`);
      sets[key] = v;
    }
    const models = req.doctor_models ?? {};
    if (typeof models !== 'object' || Array.isArray(models)) throw new HttpError(400, 'doctor_models must be an object of harness: model | null');
    const nextModels: Partial<Record<DoctorHarness, string>> = { ...(this.settings.doctor_models ?? {}) };
    for (const [h, m] of Object.entries(models)) {
      if (!(DOCTOR_HARNESSES as readonly string[]).includes(h)) throw new HttpError(400, `doctor_models.${h}: unknown harness (claude, codex, opencode)`);
      if (m === null || m === '') { delete nextModels[h as DoctorHarness]; continue; }
      if (typeof m !== 'string' || !/^[\w./:@[\]-]{1,120}$/.test(m)) throw new HttpError(400, `doctor_models.${h}: must be a model id without spaces`);
      nextModels[h as DoctorHarness] = m;
    }
    if (env.has('doctor_models') && req.doctor_models !== undefined) {
      throw new HttpError(409, 'doctor_models: set by the SPARROW_SETTINGS environment variable of this server; change it there.');
    }

    let file: Record<string, unknown>;
    try { file = readJson(this.file); } catch (e) {
      throw new HttpError(409, `${this.file} is not valid JSON (${(e as Error).message}); fix or remove it, then save again.`);
    }
    for (const [k, v] of Object.entries(sets)) file[k] = v;
    for (const k of resets) delete file[k];
    if (req.doctor_models !== undefined) {
      if (Object.keys(nextModels).length) file.doctor_models = nextModels;
      else delete file.doctor_models;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
      renameSync(tmp, this.file);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* never written */ }
      throw new HttpError(500, `Could not save ${this.file}: ${(e as Error).message}. Nothing was changed.`);
    }

    const changed: (keyof Settings)[] = [];
    const put = <K extends keyof Settings>(k: K, v: Settings[K]) => {
      if (JSON.stringify(this.settings[k]) !== JSON.stringify(v)) { this.settings[k] = v; changed.push(k); }
    };
    for (const [k, v] of Object.entries(sets)) put(k as SettingKey, v as number);
    for (const k of resets) put(k, DEFAULT_SETTINGS[k]);
    if (req.doctor_models !== undefined) put('doctor_models', nextModels);
    if (changed.length) for (const fn of this.listeners) fn(changed);
    return this.view();
  }
}
