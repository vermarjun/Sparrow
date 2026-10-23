#!/usr/bin/env bun
import { chromeExecutable } from './browser'
// Screenshots + drag proof against a running server that serves web/dist (the mock by default).
//   bun scripts/shots.ts [--url http://127.0.0.1:4140] [--log <mock url, when --url is vite>] [--out ../.sandbox/shots/T4] [--project tortuga] [--u1 | --u1-only]
// --v2 runs only the Board v2 pass (board, Later, list, Filter popover, title-line toggles, ? sheet, Triage, sheets, new-ticket dialog + interaction checks);
//   shots land in --out (use ../.sandbox/shots/board-v2 with --size 1440x900 / 1280x800 and --prefix).
// --u1 adds the U1 pages (Doctor empty → running → results, Resumes, editor, test, Start captain); the mock must
// start with no doctor run (no --doctor-done). --u1-only skips the board/chat/agents shots.
// Prints a JSON summary: console errors, page errors, and the requests a drag produced.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer, { type Page } from 'puppeteer-core'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    url: { type: 'string' }, out: { type: 'string' }, project: { type: 'string' }, 'no-drag': { type: 'boolean' }, prefix: { type: 'string' },
    card: { type: 'string' }, log: { type: 'string' }, v2: { type: 'boolean' }, u1: { type: 'boolean' }, 'u1-only': { type: 'boolean' }, dm: { type: 'string' }, dm2: { type: 'string' }, agent: { type: 'string' }, agent2: { type: 'string' }, dm3: { type: 'string' }, size: { type: 'string' },
  },
})
const URL_ = values.url ?? process.env.SPARROW_WEB_URL ?? 'http://127.0.0.1:4140'
const LOG = values.log ?? URL_ // where the mock's /__log lives (--log when --url is a vite dev server)
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.sandbox/shots/T4'))
const PROJECT = values.project ?? process.env.SPARROW_DEMO_PROJECT ?? 'tortuga'
const PREFIX = values.prefix ?? ''
const CARD = values.card ?? '3'
const DM = values.dm ?? '@captain ↔ @omar'
const DM2 = values.dm2 ?? '@maya ↔ @james'
const AGENT = values.agent ?? 'james'
const AGENT2 = values.agent2 ?? 'iris'
const DM3 = values.dm3 ?? '@maya ↔ @iris'
const [W, H] = (values.size ?? '1440x900').split('x').map(Number)
const CHROME = chromeExecutable()
mkdirSync(OUT, { recursive: true })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const consoleErrors: string[] = []
const pageErrors: string[] = []

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })
const page = await browser.newPage()
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 })
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => pageErrors.push(String(e)))

const go = async (tab: string) => {
  await page.goto(`${URL_}/#/${tab}?p=${PROJECT}`, { waitUntil: 'networkidle2' }).catch(() => {})
  await sleep(600)
}
const shot = async (name: string) => {
  await page.screenshot({ path: join(OUT, `${PREFIX}${name}.png`) })
  console.error(`shot ${PREFIX}${name}.png`)
}
async function center(p: Page, sel: string) {
  const el = await p.waitForSelector(sel, { timeout: 5000 })
  const box = await el!.boundingBox()
  return { x: box!.x + box!.width / 2, y: box!.y + Math.min(box!.height / 2, 20) }
}

const clickText = async (text: string) => {
  const ok = await page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes(t))
    b?.click()
    return !!b
  }, text)
  await sleep(700)
  return ok
}
let drag: unknown = 'skipped'
const u1: Record<string, unknown> = {}

if (!values['u1-only'] && !values.v2) {
// Board
await go('board')
await page.waitForSelector('[data-card-id]', { timeout: 8000 })
await shot('board')

if (!values['no-drag']) {
  // Drag the first To-do card into Review, then read the server's request log.
  const isMock = await fetch(`${LOG}/__log`).then((r) => r.ok && (r.headers.get('content-type') ?? '').includes('json')).catch(() => false)
  if (isMock) await fetch(`${LOG}/__log/reset`, { method: 'POST' })
  const colBox = (id: string) => page.$eval(`[data-column="${id}"]`, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, w: r.width, y: r.y, h: r.height } })
  const todo = await colBox('todo')
  const review = await colBox('review')
  const todoCard = await page.evaluate((x0: number, x1: number) =>
    [...document.querySelectorAll('[data-card-id]')].find((el) => { const r = el.getBoundingClientRect(); return r.x >= x0 && r.x < x1 })?.getAttribute('data-card-id'), todo.x, todo.x + todo.w)
  const target = { x: review.x + review.w / 2, y: review.y + 200 }
  const a = await center(page, `[data-card-id="${todoCard}"]`)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  for (let i = 1; i <= 25; i++) {
    await page.mouse.move(a.x + ((target.x - a.x) * i) / 25, a.y + ((target.y - a.y) * i) / 25)
    await sleep(16)
  }
  await sleep(150)
  await page.mouse.up()
  await sleep(1200)
  await shot('board-after-drag')
  const log = isMock ? ((await fetch(`${LOG}/__log`).then((r) => r.json())) as { method: string; path: string; body?: unknown }[]) : []
  const writes = log.filter((l) => l.method !== 'GET')
  drag = { card: todoCard, writes, gets: log.filter((l) => l.method === 'GET').map((l) => l.path) }
}

// Card sheet
await page.click(`[data-card-id="${CARD}"]`)
await sleep(700)
await shot('board-card-sheet')
await page.keyboard.press('Escape')
await sleep(150)
await page.keyboard.press('Escape')
await sleep(400)

// Chat — the DM with a result (captain ↔ omar), then the group
await go('chat')
await clickText(DM)
await shot('chat-dm-result')
await clickText(DM2)
await shot('chat-dm-question')
await clickText('Group')
await shot('chat-group')
if (await clickText(DM3)) {
  await shot('chat-crash-notice')
  const opened = await page.evaluate(() => { const d = document.querySelector('[data-testid=last-screen]') as HTMLDetailsElement | null; if (d) { d.open = true; d.scrollIntoView({ block: 'center' }) } return !!d })
  await sleep(300)
  if (opened) await shot('chat-crash-notice-open')
}

// Agents + peek
await go('agents')
await page.waitForSelector('[data-agent]')
await shot('agents')
const menu = await page.$('[aria-label="Copy tmux command"]')
if (menu) {
  await menu.click()
  await sleep(400)
  await shot('agents-tmux-menu')
  await page.keyboard.press('Escape')
  await sleep(300)
}
await page.click(`[data-agent="${AGENT}"]`)
await page.waitForFunction(() => document.querySelector('[data-testid=screen]')?.textContent?.trim().length, { timeout: 5000 }).catch(() => {})
await sleep(2500) // one poll cycle
await shot('agents-peek')
const tmuxText = await page.evaluate(() => [...document.querySelectorAll('dd')].map((d) => d.textContent).find((t) => t?.startsWith('tmux attach')))
console.error('tmux text:', tmuxText)
await page.keyboard.press('Escape')
await sleep(150)
await page.keyboard.press('Escape')
await sleep(400)
await page.click(`[data-agent="${AGENT2}"]`)
await sleep(900)
await shot('agents-peek-crashed')
}

const v2: Record<string, unknown> = {}
if (values.v2) {
  const isMock = await fetch(`${LOG}/__log`).then((r) => r.ok && (r.headers.get('content-type') ?? '').includes('json')).catch(() => false)
  const writes = async () => (isMock ? ((await fetch(`${LOG}/__log`).then((r) => r.json())) as { method: string; path: string; body?: unknown }[]).filter((l) => l.method !== 'GET') : [])
  const reset = () => (isMock ? fetch(`${LOG}/__log/reset`, { method: 'POST' }) : Promise.resolve())
  const click = (sel: string) => page.evaluate((x) => { const e = document.querySelector(x) as HTMLElement | null; e?.click(); return !!e }, sel)
  const closeOverlays = async () => { await page.keyboard.press('Escape'); await sleep(250); await page.keyboard.press('Escape'); await sleep(350) }
  const openCard = async (id: number | string) => { await page.click(`[data-card-id="${id}"]`); await sleep(800) }
  const count = (sel: string) => page.$$eval(sel, (e) => e.length)

  await go('board')
  await page.waitForSelector('[data-card-id]', { timeout: 8000 })
  await sleep(300)
  await shot('board')
  // Later expanded (To do and Proposed)
  await click('[data-testid=later-todo]')
  await click('[data-testid=later-proposed]')
  await sleep(400)
  await page.evaluate(() => document.querySelectorAll('[data-later-line]').forEach((e) => e.scrollIntoView({ block: 'center' })))
  await sleep(300)
  await shot('board-later-expanded')
  v2.laterRows = await count('[data-later=true]')
  await click('[data-testid=later-todo]')
  await click('[data-testid=later-proposed]')
  // List view
  await click('[data-seg=list]')
  await sleep(500)
  await shot('list-view')
  await click('[data-seg=board]')
  await sleep(300)
  // Filter popover and the Dropped column (Show dropped lives in the popover)
  await click('[data-testid=filter]')
  await sleep(400)
  await shot('filter-popover')
  await click('[data-testid=filter-dropped]')
  await sleep(300)
  await page.keyboard.press('Escape')
  await sleep(400)
  await shot('board-dropped')
  v2.droppedCards = await page.$$eval('[data-column="dropped"]', (e) => e.length)
  await click('[data-testid=filter]')
  await sleep(300)
  await click('[data-testid=filter-dropped]')
  await page.keyboard.press('Escape')
  await sleep(300)
  // Title-line toggles: urgent, then category (Filter popover), with a search term
  await click('[data-filter=urgent]')
  await sleep(300)
  await shot('filters-urgent')
  v2.urgentCards = await count('[data-card-id]')
  v2.urgentOnlyUrgent = (await count('[data-card-id]:not([data-urgent])')) === 0
  await click('[data-filter=urgent]')
  await page.focus('[data-testid=search]').catch(() => {})
  await page.keyboard.press('Escape')
  await page.keyboard.press('/')
  await page.keyboard.type('export')
  await sleep(300)
  v2.searchExport = await count('[data-card-id]')
  await click('[data-testid=filter]')
  await sleep(300)
  await click('[data-testid=filter-popover] [role=group][aria-label=Category] button')
  await sleep(300)
  await shot('filters-active')
  v2.searchExportCategory = await count('[data-card-id]')
  await page.keyboard.press('Escape')
  await sleep(200)
  await click('[data-testid=clear-filters]')
  await sleep(300)
  // Sheets
  await openCard(13)
  await shot('sheet-proposed')
  await page.$eval('[data-sheet-body]', (e) => { e.scrollTop = 99999 }).catch(() => {})
  await sleep(300)
  await shot('sheet-proposed-bottom')
  await closeOverlays()
  await openCard(21)
  await shot('sheet-blocked')
  await closeOverlays()
  await openCard(27)
  await shot('sheet-done')
  await page.$eval('[data-sheet-body]', (e) => { e.scrollTop = 99999 }).catch(() => {})
  await sleep(300)
  await shot('sheet-done-bottom')
  await closeOverlays()
  // Shortcut sheet (?) and Triage mode (t)
  await page.keyboard.press('?')
  await sleep(500)
  await shot('shortcut-sheet')
  v2.shortcutSheet = await count('[data-testid=shortcut-sheet]')
  await closeOverlays()
  await reset()
  await page.keyboard.press('t')
  await sleep(700)
  await shot('triage')
  v2.triageOpen = (await count('[data-testid=toolbar]')) === 0
  v2.triageWrites = (await writes()).length
  await page.keyboard.press('Escape')
  await sleep(500)
  // New ticket dialog (shortcut n)
  await page.keyboard.press('n')
  await sleep(700)
  await shot('new-ticket-dialog')
  await closeOverlays()

  // Interactions that PATCH: each must produce exactly one write.
  const checks: Record<string, unknown> = {}
  // 1. drag To do -> Review
  const dragTo = async (from: string, to: { x: number; y: number }) => {
    const a = await center(page, from)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    for (let i = 1; i <= 25; i++) { await page.mouse.move(a.x + ((to.x - a.x) * i) / 25, a.y + ((to.y - a.y) * i) / 25); await sleep(16) }
    await sleep(150)
  }
  const drop = async () => { await page.mouse.up(); await sleep(1000) }
  const colBox = (id: string) => page.$eval(`[data-column="${id}"]`, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, w: r.width, y: r.y, h: r.height } })
  await reset()
  const review = await colBox('review')
  await dragTo('[data-card-id="7"]', { x: review.x + review.w / 2, y: review.y + 300 })
  await drop()
  checks.dragWrites = await writes()
  await shot('board-after-drag')
  // 1b. drag a To do card onto the Later line (shelves it, one PATCH)
  await reset()
  const line = await page.$eval('[data-later-line="todo"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  await dragTo('[data-card-id="10"]', line)
  await shot('board-drag-to-later')
  await drop()
  checks.dragToLaterWrites = await writes()
  // 1c. a shelved card can be dragged out of Later into another column
  await click('[data-testid=later-todo]')
  await sleep(400)
  await reset()
  const inprog = await colBox('in_progress')
  await dragTo('[data-card-id="22"]', { x: inprog.x + inprog.w / 2, y: inprog.y + 200 })
  await drop()
  checks.dragOutOfLaterWrites = await writes()
  await click('[data-testid=later-todo]')
  // 1d. same-column reorder under a non-manual sort is a no-op (no write)
  await click('[data-testid=sort]')
  await sleep(300)
  const opt = await page.evaluateHandle(() => [...document.querySelectorAll('[role=option]')].find((o) => o.textContent?.includes('Newest first')) ?? null)
  await (opt.asElement() as import('puppeteer-core').ElementHandle<Element> | null)?.click()
  await sleep(500)
  await reset()
  const todoBox = await colBox('todo')
  const ids = await page.evaluate((x0: number, x1: number) => [...document.querySelectorAll('[data-card-id]')].filter((el) => { const r = el.getBoundingClientRect(); return r.x >= x0 && r.x < x1 }).slice(0, 3).map((el) => el.getAttribute('data-card-id')), todoBox.x, todoBox.x + todoBox.w)
  const third = await page.$eval(`[data-card-id="${ids[2]}"]`, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
  await dragTo(`[data-card-id="${ids[0]}"]`, third)
  await drop()
  checks.sameColumnNonManualWrites = await writes()
  await click('[data-testid=sort]')
  await sleep(300)
  const manual = await page.evaluateHandle(() => [...document.querySelectorAll('[role=option]')].find((o) => o.textContent?.includes('Manual order')) ?? null)
  await (manual.asElement() as import('puppeteer-core').ElementHandle<Element> | null)?.click()
  await sleep(400)
  // 2. hover Accept on a proposed card
  await reset()
  await page.hover('[data-card-id="13"]')
  await sleep(250)
  await shot('card-hover-actions')
  await click('[data-card-id="13"] [data-action="Accept to To do"]')
  await sleep(800)
  checks.acceptWrites = await writes()
  // 3. hover Later on a to-do card
  await reset()
  await click('[data-card-id="24"] [data-action="Move to Later"]')
  await sleep(800)
  checks.laterWrites = await writes()
  await sleep(200)
  // 4. Enter on a focused card opens it
  await page.focus('[data-kanban-item="5"]')
  await page.keyboard.press('Enter')
  await sleep(700)
  checks.enterOpensSheet = !!(await page.$('[data-ticket-sheet]'))
  await closeOverlays()
  // 5. view persisted across a reload
  await click('[data-seg=list]')
  await sleep(300)
  await page.reload({ waitUntil: 'networkidle2' })
  await sleep(700)
  checks.persisted = await page.evaluate(() => ({
    list: !!document.querySelector('[data-testid=board-list], [data-testid=list]'),
    listPressed: document.querySelector('[data-seg=list]')?.getAttribute('aria-pressed'),
  }))
  await click('[data-seg=board]')
  v2.checks = checks
}

if (values.u1 || values['u1-only']) {
  const text = (sel: string) => page.$eval(sel, (e) => e.textContent ?? '').catch(() => null)
  const hash = async (h: string) => { await page.goto(`${URL_}/#/${h}`, { waitUntil: 'networkidle2' }).catch(() => {}); await sleep(700) }
  // Doctor: empty → running → results
  await hash('doctor')
  await shot('u1-doctor-empty')
  await page.click('[data-testid=run-doctor]')
  await sleep(2200)
  await shot('u1-doctor-running')
  u1.doctorRunning = await text('[data-testid=doctor-last-run]')
  await page.waitForFunction(() => document.querySelector('[data-testid=doctor-last-run]')?.textContent?.startsWith('last run'), { timeout: 30000 })
  await sleep(800)
  await shot('u1-doctor-results')
  u1.doctorDone = await text('[data-testid=doctor-last-run]')
  u1.checks = await page.$$eval('[data-check]', (els) => els.map((e) => `${e.getAttribute('data-check')}=${e.getAttribute('data-status')}`))
  await page.evaluate(() => document.querySelector('[data-testid=catalog-panel]')?.scrollIntoView({ block: 'end' }))
  await page.click('[data-testid=refresh-models]')
  await sleep(300)
  await shot('u1-doctor-catalog-refreshing')
  await sleep(1800)
  // Resumes list
  await hash('resumes')
  await page.waitForSelector('[data-resume]')
  await shot('u1-resumes-list')
  u1.resumes = await page.$$eval('[data-resume]', (rows) => rows.map((r) => `${r.getAttribute('data-resume')}:${r.querySelector('[data-status]')?.getAttribute('data-status')}`))
  // Editor: model gone (codex), then the model dropdown with the hidden group
  await hash('resumes/builder-codex')
  await page.waitForSelector('[data-testid=model-select]')
  await shot('u1-resume-editor-model-gone')
  await page.click('[data-testid=model-select]')
  await sleep(500)
  await shot('u1-resume-editor-model-select')
  await page.keyboard.press('Escape')
  await sleep(300)
  // Editor: OpenCode logged out (greyed), model without effort levels, costs in the dropdown
  await hash('resumes/presenter')
  await page.waitForSelector('[data-testid=model-select]')
  u1.presenterEffort = await text('[data-testid=effort-note]')
  await page.click('[data-testid=model-select]')
  await sleep(500)
  await shot('u1-resume-editor-opencode')
  await page.keyboard.press('Escape')
  await sleep(300)
  // Validation error from the server, inline under the field
  await hash('resumes/scout')
  await page.waitForSelector('#title')
  await page.$eval('#title', (e) => (e as HTMLInputElement).select())
  await page.type('#title', 'Scout (fast)')
  await page.click('[data-testid=save]')
  await sleep(800)
  u1.validation = await page.$$eval('[data-field-error]', (els) => els.map((e) => `${e.getAttribute('data-field-error')}: ${e.textContent}`))
  await shot('u1-resume-editor-validation')
  // Test this resume: running → pass
  await hash('resumes/verifier')
  await page.waitForSelector('[data-testid=test-resume]')
  await page.click('[data-testid=test-resume]')
  await sleep(900)
  await shot('u1-resume-test-running')
  await page.waitForFunction(() => ['pass', 'fail'].includes(document.querySelector('[data-testid=test-panel]')?.getAttribute('data-status') ?? ''), { timeout: 20000 })
  await sleep(300)
  await shot('u1-resume-test-done')
  u1.test = await text('[data-testid=test-panel]')
  // New resume form
  await hash('resumes/_new')
  await shot('u1-resume-new')
  // Start captain
  await hash(`agents?p=${PROJECT}`)
  await page.waitForSelector('[data-agent]', { timeout: 5000 }).catch(() => {})
  await shot('u1-agents-last-run')
  await page.click('[data-testid=start-captain]')
  await sleep(800)
  await shot('u1-start-captain')
  await page.evaluate(() => (document.querySelector('[role=dialog] button[type=submit]') as HTMLButtonElement | null)?.click())
  await page.waitForSelector('[data-testid=captain-started]', { timeout: 5000 }).catch(() => {})
  await sleep(400)
  await shot('u1-start-captain-done')
  u1.attach = await text('[data-testid=attach]')
}

await browser.close()
console.log(JSON.stringify({ out: OUT, consoleErrors, pageErrors, drag, u1, v2 }, null, 2))
