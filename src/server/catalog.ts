// Model catalog cache (DB-backed, fetched in the background on start and on POST /api/catalog/refresh) plus the
// pure checks built on it: the hire gate and resume status (U1-CONTRACT "Hire gate").
import { fetchCatalog, REAL_HARNESSES, type RealHarness } from '../harness/catalog';
import type { CatalogModel, HarnessCatalog, HarnessHealth, HarnessName, Resume, ResumeStatus } from '../shared/types';
import type { Store } from './db';
import type { EventBus } from './events';

export type Fetcher = (h: RealHarness) => Promise<HarnessCatalog>;

export class CatalogService {
  private cache = new Map<string, HarnessCatalog>();
  private inflight: Promise<HarnessCatalog[]> | null = null;

  constructor(
    private store: Store,
    private events: EventBus,
    private fetcher: Fetcher = fetchCatalog,
    readonly harnesses: RealHarness[] = REAL_HARNESSES,
    private log: (line: string) => void = () => {},
  ) {
    for (const c of store.listCatalogs()) this.cache.set(c.harness, c);
  }

  list(): HarnessCatalog[] {
    return this.harnesses.map((h) => this.cache.get(h)).filter((c): c is HarnessCatalog => !!c);
  }

  get(h: HarnessName): HarnessCatalog | null { return this.cache.get(h) ?? null; }

  get refreshing() { return this.inflight !== null; }

  /** Store one harness's catalog and broadcast. */
  put(c: HarnessCatalog) {
    this.cache.set(c.harness, c);
    this.store.saveCatalog(c);
    this.events.emit({ type: 'catalog.updated', project_id: '*', catalogs: this.list() });
  }

  /** Fetch every harness in parallel (one refresh at a time; concurrent callers share it). */
  refresh(): Promise<HarnessCatalog[]> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        await Promise.all(this.harnesses.map(async (h) => {
          const c = await this.fetcher(h);
          this.log(`catalog ${h}: ${c.ok ? `${c.models.length} models (v${c.version ?? '?'})` : `FAILED ${c.error}`}`);
          this.put(c);
        }));
        return this.list();
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Refresh one harness (the doctor's catalog check). */
  async refreshOne(h: RealHarness): Promise<HarnessCatalog> {
    const c = await this.fetcher(h);
    this.put(c);
    return c;
  }
}

// ---------------------------------------------------------------- pure checks

/** Find a model by what a resume/hire names: catalog id, or (claude) the full id an alias resolves to. */
export function findModel(cat: HarnessCatalog, model: string): CatalogModel | null {
  return cat.models.find((m) => m.id === model) ?? cat.models.find((m) => m.resolves_to === model) ?? null;
}

const available = (cat: HarnessCatalog) => {
  const ids = cat.models.filter((m) => !m.hidden).map((m) => m.id);
  return ids.length > 12 ? `${ids.slice(0, 12).join(', ')}, … (${ids.length} total)` : ids.join(', ');
};

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export interface Problem { status: ResumeStatus; text: string }

/** Model + effort against the catalog. null = fine (or not checkable: no catalog / failed fetch). */
export function modelProblem(cat: HarnessCatalog | null, harness: HarnessName, model: string | null, effort: string | null): Problem | null {
  if (harness === 'fake' || !cat || !cat.ok) return null;
  if (!model) return null; // harness default
  const m = findModel(cat, model);
  if (!m) return { status: 'model_gone', text: `model ${model} no longer offered by ${harness}; available: ${available(cat)}` };
  if (effort == null) return null;
  if (!m.efforts.length) return { status: 'effort_invalid', text: `model ${model} on ${harness} has no effort levels; set effort to none (got ${effort})` };
  if (!m.efforts.includes(effort)) return { status: 'effort_invalid', text: `effort ${effort} is not supported by ${model} on ${harness}; supported: ${m.efforts.join(', ')}` };
  return null;
}

/** Install/login/working verdict from the latest finished doctor run. */
export function healthProblem(health: HarnessHealth | null, harness: HarnessName, now = Date.now()): Problem | null {
  if (harness === 'fake' || !health) return null;
  const when = health.checked_at ? `doctor, ${ago(health.checked_at, now)}` : 'doctor';
  if (health.installed === false) return { status: 'harness_missing', text: `${harness} is not installed (${when}). Fix: ${health.fix ?? `install ${harness}`}` };
  if (health.logged_in === false) return { status: 'harness_logged_out', text: `${harness} is not logged in (${when}). Fix: ${health.fix ?? `log in to ${harness}`}` };
  if (health.working === false) return { status: 'harness_broken', text: `${harness} failed its live round trip (${when}). Fix: ${health.fix ?? 'see the doctor page'}` };
  return null;
}

/**
 * Hire gate (before the agent row is inserted). Returns the refusal text, or null to allow.
 * A failed round trip alone does not block hiring (only missing / logged out do); never substitutes a model.
 */
export function gateCheck(cat: HarnessCatalog | null, health: HarnessHealth | null, harness: HarnessName, model: string | null, effort: string | null, now = Date.now()): string | null {
  if (harness === 'fake') return null;
  const hp = healthProblem(health, harness, now);
  if (hp && hp.status !== 'harness_broken') return hp.text;
  const mp = modelProblem(cat, harness, model, effort);
  return mp ? mp.text : null;
}

export function resumeStatus(r: Pick<Resume, 'harness' | 'model' | 'effort'>, cat: HarnessCatalog | null, health: HarnessHealth | null, now = Date.now()): { status: ResumeStatus; detail: string | null; resolved: string | null } {
  const resolved = cat && r.model ? findModel(cat, r.model)?.resolves_to ?? null : null;
  if (r.harness === 'fake') return { status: 'ok', detail: null, resolved };
  const p = healthProblem(health, r.harness, now) ?? modelProblem(cat, r.harness, r.model, r.effort);
  if (p) return { status: p.status, detail: p.text, resolved };
  if (!cat?.ok && !health) return { status: 'unchecked', detail: cat?.error ?? 'no model catalog yet', resolved };
  return { status: 'ok', detail: null, resolved };
}
