#!/usr/bin/env bun
// README / docs screenshots of the web UI: the tortuga demo world from mock/seed.ts, 1440x900 at 2x, light and dark.
//   bun scripts/readme-shots.ts                         # all shots into ../docs/images (builds web/dist if it is missing)
//   bun scripts/readme-shots.ts --only ui-board-light,ui-ticket --out /tmp/shots
//   bun scripts/readme-shots.ts --url http://127.0.0.1:4140   # use a mock you started yourself (--no-live --doctor-done)
// Needs Chrome: set CHROME_BIN or put chromium/google-chrome on PATH (scripts/browser.ts). Starts its own mock on a free
// port (never the real server), then shrinks every PNG with pngquant + oxipng to <= 450 KB.
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer, { type Page } from 'puppeteer-core'
import { chromeExecutable } from './browser'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { out: { type: 'string' }, only: { type: 'string' }, url: { type: 'string' } } })
const WEB = resolve(import.meta.dir, '..')
const OUT = resolve(values.out ?? join(WEB, '..', 'docs', 'images'))
const ONLY = values.only?.split(',')
const PROJECT = 'tortuga'
const MAX_BYTES = 450 * 1024
mkdirSync(OUT, { recursive: true })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const freePort = () => { const s = Bun.serve({ port: 0, fetch: () => new Response('') }); const p = s.port; s.stop(true); return p }

// ---------------------------------------------------------------- the mock (stable data: no live ticks)
let mock: ReturnType<typeof Bun.spawn> | null = null
let base = values.url
if (!base) {
  if (!existsSync(join(WEB, 'dist', 'index.html'))) {
    const b = Bun.spawnSync(['bun', 'run', 'build'], { cwd: WEB, stdout: 'inherit', stderr: 'inherit' })
    if (b.exitCode !== 0) throw new Error('bun run build failed')
  }
  const port = freePort()
  mock = Bun.spawn(['bun', join(WEB, 'mock', 'server.ts'), '--port', String(port), '--no-live', '--quiet', '--doctor-done'], { cwd: WEB, stdout: 'ignore', stderr: 'inherit' })
  base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 60 && !(await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(100)
}

// ---------------------------------------------------------------- shots
type Theme = 'light' | 'dark'
interface Shot {
  name: string
  theme: Theme
  hash: string
  /** Wait for / click things after the route loaded. */
  prep?: (page: Page) => Promise<void>
  /** Viewport height in CSS pixels (default 900; the ticket sheet is taller). */
  height?: number
  /** Crop to this many CSS pixels from the top (default: the whole viewport). */
  crop?: number
}

const scrollFeedToEnd = (page: Page) => page.evaluate(() => { const f = document.querySelector<HTMLElement>('[data-testid=feed]'); if (f) f.scrollTop = f.scrollHeight })

const SHOTS: Shot[] = [
  ...(['light', 'dark'] as const).map((theme): Shot => ({ name: `ui-captains-${theme}`, theme, hash: 'captains', crop: 520 })),
  ...(['light', 'dark'] as const).map((theme): Shot => ({
    name: `ui-activity-${theme}`, theme, hash: 'captain/ag_orion',
    prep: async (page) => { await sleep(600); await scrollFeedToEnd(page); await sleep(400) },
  })),
  {
    name: 'ui-team', theme: 'light', hash: 'captain/ag_cap?tab=team&agent=ag_maya',
    prep: async (page) => { await page.waitForSelector('[data-testid=agent-sheet]'); await sleep(2600) }, // the screen peek polls every 2 s
  },
  ...(['light', 'dark'] as const).map((theme): Shot => ({ name: `ui-board-${theme}`, theme, hash: 'board' })),
  {
    name: 'ui-ticket', theme: 'light', hash: 'board', height: 1400, crop: 1180,
    prep: async (page) => { await page.waitForSelector('[data-card-id="2"]'); await page.click('[data-card-id="2"]'); await page.waitForSelector('[role=dialog]'); await sleep(600); await page.evaluate(() => { [...document.querySelectorAll<HTMLElement>('[role=dialog] button')].find((b) => b.textContent?.trim().startsWith('Est'))?.click() }); await sleep(600) },
  },
  { name: 'ui-triage', theme: 'light', hash: 'board', prep: async (page) => { await page.keyboard.press('t'); await sleep(800); await page.evaluate(() => { [...document.querySelectorAll<HTMLElement>('[role=option], li, button, div')].filter((e) => e.children.length < 6 && e.textContent?.includes('Audit log for failed')).pop()?.click() }); await sleep(800) } },
  { name: 'ui-resumes', theme: 'light', hash: 'resumes/builder', prep: async () => { await sleep(1200) } },
]

const browser = await puppeteer.launch({ executablePath: chromeExecutable(), args: ['--no-sandbox'], headless: true })
const sizes: [string, number][] = []
try {
  for (const s of SHOTS) {
    if (ONLY && !ONLY.includes(s.name)) continue
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: s.height ?? 900, deviceScaleFactor: 2 })
    await page.evaluateOnNewDocument((t) => { try { localStorage.setItem('sparrow.theme', t) } catch { /* private mode */ } }, s.theme)
    await page.goto(`${base}/#/${s.hash}${s.hash.includes('?') ? '&' : '?'}p=${PROJECT}`, { waitUntil: 'networkidle2' })
    await sleep(1200)
    await s.prep?.(page)
    const file = join(OUT, `${s.name}.png`)
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1440, height: s.crop ?? s.height ?? 900 } })
    await page.close()
    // pngquant first (lossy palette), then oxipng; step the quality down until it fits.
    for (const q of ['70-90', '55-80', '40-65']) {
      Bun.spawnSync(['pngquant', '--quality', q, '--speed', '1', '--strip', '--force', '--output', file, file])
      Bun.spawnSync(['oxipng', '-o', '4', '--strip', 'safe', '--quiet', file])
      if (statSync(file).size <= MAX_BYTES) break
    }
    sizes.push([s.name, statSync(file).size])
    console.error(`${s.name}.png  ${(statSync(file).size / 1024).toFixed(0)} KB`)
  }
} finally {
  await browser.close()
  mock?.kill()
}
const over = sizes.filter(([, n]) => n > MAX_BYTES)
if (over.length) { console.error(`over ${MAX_BYTES / 1024} KB: ${over.map(([n]) => n).join(', ')}`); process.exit(1) }
