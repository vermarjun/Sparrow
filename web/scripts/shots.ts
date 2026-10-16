#!/usr/bin/env bun
// Screenshots + drag proof against a running server that serves web/dist (the mock by default).
//   bun scripts/shots.ts [--url http://127.0.0.1:4140] [--out ../.orchestra/shots/T4] [--project plutus] [--u1 | --u1-only]
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
    card: { type: 'string' }, u1: { type: 'boolean' }, 'u1-only': { type: 'boolean' }, dm: { type: 'string' }, dm2: { type: 'string' }, agent: { type: 'string' }, agent2: { type: 'string' }, dm3: { type: 'string' }, size: { type: 'string' },
  },
})
const URL_ = values.url ?? 'http://127.0.0.1:4140'
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.orchestra/shots/T4'))
const PROJECT = values.project ?? 'plutus'
const PREFIX = values.prefix ?? ''
const CARD = values.card ?? '3'
const DM = values.dm ?? '@captain ↔ @omar'
const DM2 = values.dm2 ?? '@maya ↔ @james'
const AGENT = values.agent ?? 'james'
const AGENT2 = values.agent2 ?? 'iris'
const DM3 = values.dm3 ?? '@maya ↔ @iris'
const [W, H] = (values.size ?? '1440x900').split('x').map(Number)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
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

if (!values['u1-only']) {
// Board
await go('board')
await page.waitForSelector('[data-card-id]', { timeout: 8000 })
await shot('board')

if (!values['no-drag']) {
  // Drag the first To-do card into Review, then read the server's request log.
  const isMock = await fetch(`${URL_}/__log`).then((r) => r.ok && (r.headers.get('content-type') ?? '').includes('json')).catch(() => false)
  if (isMock) await fetch(`${URL_}/__log/reset`, { method: 'POST' })
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
  const log = isMock ? ((await fetch(`${URL_}/__log`).then((r) => r.json())) as { method: string; path: string; body?: unknown }[]) : []
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
console.log(JSON.stringify({ out: OUT, consoleErrors, pageErrors, drag, u1 }, null, 2))
