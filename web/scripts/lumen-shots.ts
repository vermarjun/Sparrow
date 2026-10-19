#!/usr/bin/env bun
// Board-level upgrades: toolbar legend, column header stats, keyboard triage. Run against a mock + vite (see .orchestra/FACE-BRIEF.md "Where").
//   bun scripts/lumen-shots.ts [--url http://localhost:5184] [--mock http://127.0.0.1:4154] [--out ../.orchestra/shots/faces] [--project plutus]
// Proves with request logging that j/j/a/l/u sends the right PATCHes; exits 1 on a failed check.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer, { type KeyInput, type Page } from 'puppeteer-core'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' }, mock: { type: 'string' }, out: { type: 'string' }, project: { type: 'string' } } })
const URL_ = values.url ?? 'http://localhost:5184'
const MOCK = values.mock ?? 'http://127.0.0.1:4154'
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.orchestra/shots/faces'))
const PROJECT = values.project ?? 'plutus'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DAY = 86_400_000
mkdirSync(OUT, { recursive: true })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const failures: string[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.error(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`)
  if (!ok) failures.push(name)
}
type Req = { method: string; path: string; body?: Record<string, unknown> }
const writes = async () => ((await fetch(`${MOCK}/__log`).then((r) => r.json())) as Req[]).filter((l) => l.method !== 'GET')
const resetLog = () => fetch(`${MOCK}/__log/reset`, { method: 'POST' })

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })
const consoleErrors: string[] = []
async function open(age: boolean): Promise<Page> {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
  if (age) {
    // The seed has no proposal older than 14 days: age the two oldest Proposed cards in the response so the stale count shows.
    await page.setRequestInterception(true)
    page.on('request', async (req) => {
      const u = new globalThis.URL(req.url())
      if (u.pathname !== '/api/cards' || req.method() !== 'GET') return void req.continue()
      const cards = (await fetch(`${MOCK}/api/cards${u.search}`).then((r) => r.json())) as { id: number; state: string; created_at: number }[]
      const old = cards.filter((c) => c.state === 'proposed').sort((a, b) => a.created_at - b.created_at).slice(0, 2)
      old.forEach((c, i) => { c.created_at -= (18 + i * 9) * DAY })
      void req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(cards) })
    })
  }
  await page.goto(`${URL_}/#/board?p=${PROJECT}`, { waitUntil: 'networkidle2' }).catch(() => {})
  await page.waitForSelector('[data-card-id]', { timeout: 8000 }).catch(async (e) => { await page.screenshot({ path: join(OUT, 'lumen-debug.png') }); console.error(consoleErrors); throw e })
  await sleep(500)
  return page
}
const focused = (page: Page) => page.evaluate(() => document.querySelector('.kb-focus [data-card-id]')?.getAttribute('data-card-id') ?? null)
const press = async (page: Page, key: KeyInput, shift = false) => {
  if (shift) await page.keyboard.down('Shift')
  await page.keyboard.press(key)
  if (shift) await page.keyboard.up('Shift')
  await sleep(250)
}

// ---------------------------------------------------------------- screenshots
{
  const page = await open(true)
  await page.screenshot({ path: join(OUT, 'lumen-board.png') })
  const tb = await page.$eval('[data-testid=toolbar]', (e) => { const r = e.getBoundingClientRect(); return { x: 0, y: r.y - 6, width: 1440, height: r.height + 12 } })
  await page.screenshot({ path: join(OUT, 'lumen-toolbar.png'), clip: tb })
  const hd = await page.$$eval('[data-column]', (els) => { const r = els.map((e) => e.getBoundingClientRect()); return { x: r[0].x - 4, y: r[0].y - 4, width: r.at(-1)!.right - r[0].x + 8, height: r[0].height + 8 } })
  await page.screenshot({ path: join(OUT, 'lumen-columns.png'), clip: hd })
  const stats = await page.$$eval('[data-stats]', (els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-stats'), e.textContent])))
  console.error('header stats', JSON.stringify(stats))
  check('Proposed header shows stale, urgent, blocked and an estimate', /\d/.test(stats.proposed ?? '') && /~/.test(stats.proposed ?? ''), stats)
  check('stale chip present in Proposed only', (await page.$$('[data-stat=stale]')).length === 1)
  const chips = await page.$$eval('[data-filter]', (els) => els.map((e) => `${e.getAttribute('data-filter')}:${e.querySelector('[data-swatch]')?.getAttribute('data-swatch') ?? '-'}`))
  console.error('chips', chips.join(' '))
  check('every legend chip has its swatch', ['urgent:urgent', 'blocked:blocked', 'quick:quick', 'later:later'].every((c) => chips.includes(c)), chips)
  await page.hover('[data-stat=stale]')
  await sleep(700)
  await page.screenshot({ path: join(OUT, 'lumen-stale-tooltip.png'), clip: { x: 0, y: hd.y, width: 700, height: 200 } })
  await page.close()
}

// ---------------------------------------------------------------- keyboard: j j a l u
{
  const page = await open(false)
  // Board order = what j walks: read it from the DOM (column by column, top to bottom).
  const order = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('[data-column]')].map((h) => h.getBoundingClientRect()).sort((a, b) => a.x - b.x)
    return [...document.querySelectorAll('[data-card-id]')].map((el) => ({ id: Number(el.getAttribute('data-card-id')), r: el.getBoundingClientRect() }))
      .map((c) => ({ id: c.id, col: cols.findLastIndex((h) => c.r.x >= h.x - 2), y: c.r.y }))
      .sort((a, b) => a.col - b.col || a.y - b.y).map((c) => c.id)
  })
  console.error('board order', order.slice(0, 8).join(','))
  await page.$eval('body', (b) => (b as HTMLElement).focus())
  await resetLog()
  await press(page, 'j')
  check('first j focuses the first card', (await focused(page)) === String(order[0]), await focused(page))
  await press(page, 'j')
  const second = await focused(page)
  check('second j moves to the next card', second === String(order[1]), second)
  await page.screenshot({ path: join(OUT, 'lumen-focus.png'), clip: { x: 0, y: 0, width: 1440, height: 900 } })
  await press(page, 'a')
  const afterA = await focused(page)
  check('after a, the focus advances to the next card', afterA === String(order[2]), afterA)
  await press(page, 'l')
  const afterL = await focused(page)
  check('after l, the focus advances again', afterL === String(order[3]), afterL)
  await press(page, 'u')
  await sleep(300)
  const w = await writes()
  console.error('PATCHes', JSON.stringify(w))
  check('exactly three PATCHes', w.length === 3 && w.every((x) => x.method === 'PATCH'), w)
  check('a: PATCH state=todo on the 2nd card', w[0]?.path === `/api/cards/${order[1]}` && w[0].body?.state === 'todo' && typeof w[0].body?.position === 'number', w[0])
  check('l: PATCH later=true on the 3rd card', w[1]?.path === `/api/cards/${order[2]}` && w[1].body?.later === true, w[1])
  check('u: PATCH urgent on the 4th card', w[2]?.path === `/api/cards/${order[3]}` && w[2].body?.urgent === true, w[2])
  check('u keeps the focus where it was', (await focused(page)) === String(order[3]), await focused(page))
  await page.screenshot({ path: join(OUT, 'lumen-after-keys.png') })

  // 2 / shift+3 / d (with the undo toast)
  await resetLog()
  await press(page, '2')
  await press(page, '3', true)
  const w2 = await writes()
  check('2 sets return medium, shift+3 sets effort high', w2[0]?.body?.impact === 'medium' && w2[1]?.body?.effort === 'high', w2)
  await press(page, 'k')
  check('k steps back (9 left Proposed, 13 is shelved: 8 precedes 14)', (await focused(page)) === String(order[0]), await focused(page))
  await resetLog()
  await press(page, 'd')
  const w3 = await writes()
  check('d drops with PATCH state=dropped', w3[0]?.body?.state === 'dropped', w3)
  await sleep(400)
  check('d shows an Undo toast', await page.evaluate(() => !!document.querySelector('[data-sonner-toast]')?.textContent?.includes('Undo')))
  await page.screenshot({ path: join(OUT, 'lumen-drop-toast.png') })

  // Enter opens, keys pause while the sheet is open, search ignores triage keys
  await press(page, 'Enter')
  check('Enter opens the sheet', !!(await page.$('[role=dialog]')))
  await resetLog()
  await press(page, 'u')
  await press(page, 'j')
  check('keys are ignored while the sheet is open', (await writes()).length === 0)
  await press(page, 'Escape')
  await sleep(300)
  await page.focus('[data-testid=search]')
  await page.keyboard.type('jaud')
  await sleep(200)
  check('typing in search sends no PATCH', (await writes()).length === 0)
  await page.$eval('[data-testid=search]', (e) => { (e as HTMLInputElement).blur() })
  await page.close()
}

// ---------------------------------------------------------------- hint popover
{
  const page = await open(false)
  await page.click('[data-testid=keyboard-hint]')
  await sleep(500)
  const t = await page.$eval('[data-testid=toolbar]', (e) => e.getBoundingClientRect().y)
  await page.screenshot({ path: join(OUT, 'lumen-hint.png'), clip: { x: 900, y: t - 6, width: 540, height: 380 } })
  await page.close()
}

console.error('console errors', JSON.stringify(consoleErrors.filter((e) => !/favicon/.test(e))))
await browser.close()
if (failures.length) { console.error(`${failures.length} check(s) failed: ${failures.join('; ')}`); process.exit(1) }
console.error('all checks passed')
