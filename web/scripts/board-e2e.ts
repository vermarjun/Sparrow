#!/usr/bin/env bun
import { chromeExecutable } from './browser'
// Board interactions against a REAL Sparrow server (or the mock): creates two probe tickets, drives the board with a real
// browser (drag, hover actions, Later line, search) and confirms every result with GET /api/cards/:id. Probes end in Dropped.
//   bun scripts/board-e2e.ts --url http://127.0.0.1:4140 --project tortuga [--out ../.sandbox/shots/board-v2] [--size 1440x900]
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer from 'puppeteer-core'
import type { Card } from '../../src/shared/types'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' }, project: { type: 'string' }, out: { type: 'string' }, size: { type: 'string' }, prefix: { type: 'string' } } })
const URL_ = values.url ?? process.env.SPARROW_WEB_URL ?? 'http://127.0.0.1:4140'
const PROJECT = values.project ?? process.env.SPARROW_DEMO_PROJECT ?? 'tortuga'
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.sandbox/shots/board-v2'))
const PREFIX = values.prefix ?? 'e2e-'
const [W, H] = (values.size ?? '1440x900').split('x').map(Number)
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${URL_}${path}`, { method, headers: { 'content-type': 'application/json', origin: URL_ }, body: body === undefined ? undefined : JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`)
  return j
}
const get = (id: number) => api('GET', `/api/cards/${id}`) as Promise<Card>
const stamp = Date.now().toString(36)

const a = (await api('POST', '/api/cards', { project: PROJECT, title: `E2E probe A ${stamp}`, state: 'todo', urgent: false, impact: 'high', effort: 'low', category: 'e2e' })).card as Card
const b = (await api('POST', '/api/cards', { project: PROJECT, title: `E2E probe B ${stamp}`, state: 'proposed', category: 'e2e', checks: ['one', 'two'] })).card as Card
console.error(`probes: #${a.id} (todo), #${b.id} (proposed)`)

const consoleErrors: string[] = []
const writes: { method: string; url: string; body: unknown }[] = []
const browser = await puppeteer.launch({ executablePath: chromeExecutable(), args: ['--no-sandbox'], headless: true })
const page = await browser.newPage()
await page.setViewport({ width: W, height: H })
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(String(e)))
page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/cards')) writes.push({ method: r.method(), url: r.url().replace(URL_, ''), body: JSON.parse(r.postData() ?? 'null') }) })
const click = (sel: string) => page.evaluate((x) => { const e = document.querySelector(x) as HTMLElement | null; e?.click(); return !!e }, sel)
const centerOf = (sel: string) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 24) } })
const dragTo = async (from: string, to: { x: number; y: number }) => {
  const s = await centerOf(from)
  await page.mouse.move(s.x, s.y); await page.mouse.down()
  for (let i = 1; i <= 25; i++) { await page.mouse.move(s.x + ((to.x - s.x) * i) / 25, s.y + ((to.y - s.y) * i) / 25); await sleep(16) }
  await sleep(150); await page.mouse.up(); await sleep(1100)
}
const results: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail?: unknown) => { results[name] = ok ? 'ok' : { FAILED: detail }; if (!ok) console.error('FAILED', name, detail) }
const settle = async () => { await sleep(800) }

try {
  await page.goto(`${URL_}/#/board?p=${PROJECT}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector(`[data-card-id="${a.id}"]`, { timeout: 10000 })
  // search narrows to the probes
  await page.focus('[data-testid=search]'); await page.keyboard.type(`E2E probe`)
  await sleep(400)
  const found = await page.$$eval('[data-card-id]', (e) => e.length)
  check('search narrows the board to the two probes', found === 2, found)
  await page.screenshot({ path: join(OUT, `${PREFIX}search-${W}x${H}.png`) })

  // the title line counts the filtered tickets; the Filter popover and the ? sheet open
  const title = await page.$eval('[data-testid=summary]', (e) => e.textContent ?? '')
  check('title line says "2 of N tickets" while searching', /^2 of \d+ tickets/.test(title), title)
  await click('[data-testid=filter]'); await sleep(300)
  check('Filter popover opens', !!(await page.$('[data-testid=filter-popover]')))
  await page.keyboard.press('Escape'); await sleep(250)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('?'); await sleep(400)
  check('? opens the shortcut sheet', !!(await page.$('[data-testid=shortcut-sheet]')))
  await page.keyboard.press('Escape'); await sleep(300)

  // 1. drag A (todo) -> Review: exactly one PATCH, server agrees
  writes.length = 0
  const review = await page.$eval('[data-column="review"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width * 0.85, y: r.y + 120 } })
  await dragTo(`[data-card-id="${a.id}"]`, review)
  const ga = await get(a.id)
  check('drag to Review: one PATCH', writes.length === 1 && writes[0].method === 'PATCH', writes)
  check('drag to Review: server state + history', ga.state === 'review' && ga.history.at(-1)?.to === 'review' && ga.history.at(-1)?.from === 'todo', ga.history)
  await page.screenshot({ path: join(OUT, `${PREFIX}after-drag-${W}x${H}.png`) })

  // 2. hover Accept on proposed B
  writes.length = 0
  await page.hover(`[data-card-id="${b.id}"]`); await sleep(250)
  await click(`[data-card-id="${b.id}"] [data-action="Accept to To do"]`); await settle()
  const gb = await get(b.id)
  check('Accept: one PATCH, server state todo', writes.length === 1 && gb.state === 'todo', { writes, state: gb.state })
  // 2b. the toast's Undo puts it back (PATCH to the previous state), then accept again so the rest of the run is unchanged
  writes.length = 0
  const undone = await page.evaluate(() => { const u = [...document.querySelectorAll<HTMLElement>('[data-sonner-toast] button')].find((x) => x.textContent?.trim() === 'Undo'); u?.click(); return !!u })
  await settle()
  check('Accept Undo: toast button reverts the server state', undone && writes.length === 1 && (await get(b.id)).state === 'proposed', { undone, writes })
  await page.hover(`[data-card-id="${b.id}"]`); await sleep(250)
  await click(`[data-card-id="${b.id}"] [data-action="Accept to To do"]`); await settle()

  // 3. hover Later, then Bring back
  writes.length = 0
  await click(`[data-card-id="${b.id}"] [data-action="Move to Later"]`); await settle()
  check('Later: server later_at set', !!(await get(b.id)).later_at && writes.length === 1, writes)
  await click('[data-testid=later-todo]'); await sleep(400)
  await page.screenshot({ path: join(OUT, `${PREFIX}later-open-${W}x${H}.png`) })
  writes.length = 0
  await page.hover(`[data-card-id="${b.id}"]`); await sleep(250)
  await click(`[data-card-id="${b.id}"] [data-action="Bring back from Later"]`); await settle()
  check('Bring back: server later_at cleared', (await get(b.id)).later_at === null && writes.length === 1, writes)

  // 4. drag B onto the Later line
  writes.length = 0
  const line = await page.$eval('[data-later-line="todo"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  await dragTo(`[data-card-id="${b.id}"]`, line)
  const gb2 = await get(b.id)
  check('drag onto Later line: one PATCH, shelved, still To do', writes.length === 1 && !!gb2.later_at && gb2.state === 'todo', { writes, gb2: { state: gb2.state, later_at: gb2.later_at } })
  const events = gb2.notes.filter((n) => n.kind === 'event').map((n) => n.text)
  check('server logged events for the moves', events.some((t) => /later/i.test(t)), events)

  // 5. reload keeps the view
  await click('[data-seg=list]'); await sleep(300)
  await page.reload({ waitUntil: 'networkidle2' }); await sleep(700)
  check('view persisted across reload', await page.evaluate(() => !!document.querySelector('[data-testid=board-list], [data-testid=list]')))
  await click('[data-seg=board]')
} finally {
  for (const c of [a, b]) await api('PATCH', `/api/cards/${c.id}`, { state: 'dropped' }).catch(() => {})
  await browser.close()
}
console.log(JSON.stringify({ url: URL_, project: PROJECT, probes: [a.id, b.id], results, consoleErrors }, null, 2))
if (Object.values(results).some((r) => r !== 'ok') || consoleErrors.length) process.exit(1)
