// Server entry: startServer() for `sparrow up`, createApp() for tests.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RealHarness } from '../harness/catalog';
import type { Spawner } from '../harness/index';
import { isSandboxHome } from '../harness/env';
import { ASSETS, DB_PATH, loadSettings, PID_FILE, PORT, REPO_ROOT, RESUMES_DIR, type Settings, TMUX_PREFIX } from '../shared/config';
import type { HarnessName } from '../shared/types';
import { createApi } from './api';
import { CatalogService, type Fetcher } from './catalog';
import { type Clock, Core, realClock } from './core';
import { Store } from './db';
import { Doctor, type HarnessOps, type SharedCheck } from './doctor';
import { EventBus } from './events';
import { PROTOCOL_PATH } from './prompts';
import { Resumes } from './resumes';

export const VERSION: string = (() => {
  try { return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
})();

export function shouldRefreshCatalogsAtStartup(): boolean {
  return process.env.SPARROW_NO_CATALOG_REFRESH !== '1' && !isSandboxHome();
}

export interface AppDeps {
  spawner: Spawner;
  store?: Store;                 // default: new Store(dbPath ?? ':memory:')
  dbPath?: string;
  settings?: Partial<Settings>;  // merged over loadSettings()
  resumeDirs?: string[];         // default [RESUMES_DIR, assets/resumes]
  clock?: Clock;
  log?: (line: string) => void;
  tmuxPrefix?: string;
  protocolPath?: string;
  deliverDelayMs?: number;
  detectRoot?: (cwd: string) => string;
  webDist?: string | null;
  pingMs?: number;
  doctorRoot?: string;
  // U1 (tests inject these): catalog fetcher + harness list, doctor harnesses / probes / shared checks.
  fetcher?: Fetcher;
  catalogHarnesses?: RealHarness[];
  doctorHarnesses?: HarnessName[];
  doctorOps?: HarnessOps;
  doctorShared?: SharedCheck[];
  launchCaptain?: typeof import('../harness/captain').launchCaptain;
}

export function createApp(deps: AppDeps) {
  const settings: Settings = { ...loadSettings(), ...(deps.settings ?? {}) };
  const store = deps.store ?? new Store(deps.dbPath ?? ':memory:');
  const events = new EventBus();
  const resumes = new Resumes(deps.resumeDirs ?? [RESUMES_DIR, join(ASSETS, 'resumes')], settings);
  const core = new Core({
    store, spawner: deps.spawner, settings, resumes, events, clock: deps.clock ?? realClock, log: deps.log,
    tmuxPrefix: deps.tmuxPrefix ?? TMUX_PREFIX, protocolPath: deps.protocolPath ?? PROTOCOL_PATH,
    deliverDelayMs: deps.deliverDelayMs, detectRoot: deps.detectRoot, doctorRoot: deps.doctorRoot,
  });
  const log = deps.log ?? (() => {});
  const catalogs = new CatalogService(store, events, deps.fetcher, deps.catalogHarnesses, log);
  core.catalogs = catalogs;
  const doctor = new Doctor({
    core, catalogs, settings, harnesses: deps.doctorHarnesses, ops: deps.doctorOps, shared: deps.doctorShared, log,
  });
  core.healthOf = (h) => doctor.health(h);
  const app = createApi(core, {
    version: VERSION, startedAt: Date.now(), webDist: deps.webDist ?? null, pingMs: deps.pingMs, catalogs, doctor,
    launchCaptain: deps.launchCaptain,
  });
  return { app, core, store, events, settings, catalogs, doctor };
}

/** {"pid","port","started_at"} — read by `sparrow`/`sparrow status`/`sparrow stop`. */
export function writePidFile(port: number, file = PID_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, port, started_at: Date.now() }) + '\n');
}

/** Remove the pidfile only if it is still ours (another server may have replaced it). */
export function removePidFile(file = PID_FILE) {
  try {
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file);
  } catch { /* unreadable: leave it */ }
}

export interface StartOpts {
  port?: number;
  spawner?: Spawner;
  webDist?: string;
  settings?: Partial<Settings>;
  log?: (line: string) => void;
}

export async function startServer(opts: StartOpts = {}): Promise<{ port: number; stop(): Promise<void> }> {
  let spawner = opts.spawner;
  if (!spawner) {
    const path = '../harness/spawner';
    const mod = await import(path);
    spawner = mod.createSpawner() as Spawner;
  }
  const log = opts.log ?? ((l: string) => console.log(l));
  const { app, core, store, settings, catalogs } = createApp({
    spawner, dbPath: DB_PATH, settings: opts.settings, log, webDist: opts.webDist ?? join(REPO_ROOT, 'web', 'dist'),
  });
  const port = opts.port ?? PORT;
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: '127.0.0.1', port, fetch: app.fetch, idleTimeout: 0 });
  } catch (err) {
    store.close();
    const e = err as Error & { code?: string };
    if (e.code === 'EADDRINUSE' || /in use/i.test(e.message)) {
      throw new Error(`Port ${port} is already in use — is another Sparrow server running? (check: curl http://127.0.0.1:${port}/api/health)`);
    }
    throw err;
  }
  // Spawned agents derive SPARROW_URL from this at launch time (src/harness/env.ts).
  if (!process.env.SPARROW_URL) process.env.SPARROW_PORT = String(server.port);
  log(`sparrow ${VERSION} listening on http://127.0.0.1:${server.port} (db ${DB_PATH}, max_running ${settings.max_running})`);
  writePidFile(server.port as number);
  const onExit = () => removePidFile();
  process.on('exit', onExit);
  // A non-default SPARROW_HOME is commonly a demo/test sandbox. Keep its probes and caches isolated:
  // catalog refresh is available on demand via POST /api/catalog/refresh.
  if (shouldRefreshCatalogsAtStartup()) {
    catalogs.refresh().catch((e) => log(`catalog refresh failed: ${(e as Error).message}`));
  } else {
    log('catalog refresh skipped for sandbox home; use POST /api/catalog/refresh to refresh explicitly');
  }
  await core.recover();
  const wd = setInterval(() => { core.watchdogTick().catch((e) => log(`watchdog error: ${(e as Error).message}`)); }, settings.watchdog_ms);
  const snap = setInterval(() => { core.snapshotTick().catch(() => {}); }, settings.snapshot_ms);
  let stopped = false;
  return {
    port: server.port as number,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(wd);
      clearInterval(snap);
      core.stop();
      server.stop(true);
      store.close();
      removePidFile();
      process.off('exit', onExit);
    },
  };
}
