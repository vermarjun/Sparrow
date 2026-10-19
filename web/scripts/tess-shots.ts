#!/usr/bin/env bun
// Board v3 chrome check: one toolbar row, the title line as filter, Filter popover, undo toasts, `?` sheet, Triage entry.
// Runs against the mock + vite (never the live server). Writes 1440x900 and 1280x800 shots and prints a PASS/FAIL list.
//   bun scripts/tess-shots.ts [--url http://localhost:5191] [--mock http://127.0.0.1:4161] [--out ../.orchestra/shots/v3] [--project plutus]
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer, { type Page } from 'puppeteer-core'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' }, mock: { type: 'string' }, out: { type: 'string' }, project: { type: 'string' } } })
const URL_ = values.url ?? 'http://localhost:5191'
const MOCK = values.mock ?? 'http://127.0.0.1:4161'
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.orchestra/shots/v3'))
const PROJECT = values.project ?? 'plutus'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const results: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail: detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

type Req = { method: string; path: string; body?: Record<string, unknown> }
const resetLog = () => fetch(`${MOCK}/__log/reset`, { method: 'POST' })
const writes = async (): Promise<Req[]> => ((await fetch(`${MOCK}/__log`).then((r) => r.json())) as Req[]).filter((l) => l.method !== 'GET')

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })
const page = await browser.newPage()
const errors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
const board = `${URL_}/#/board?p=${PROJECT}`
const fresh = async () => {
  await page.goto(board, { waitUntil: 'networkidle2' }).catch(() => {})
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'networkidle2' }).catch(() => {})
  await page.waitForSelector('[data-card-id]', { timeout: 8000 })
  await sleep(500)
}
const shot = async (name: string) => { await page.screenshot({ path: join(OUT, `tess-${name}.png`) }); console.log(`shot tess-${name}.png`) }
const text = (sel: string) => page.$eval(sel, (e) => e.textContent?.replace(/\s+/g, ' ').trim() ?? '').catch(() => null)
const count = (sel: string) => page.$$eval(sel, (e) => e.length)
const pressed = (sel: string) => page.$eval(sel, (e) => e.getAttribute('aria-pressed') === 'true').catch(() => null)
const clickText = (t: string, within = 'button') => page.evaluate((t, within) => {
  const b = [...document.querySelectorAll<HTMLElement>(within)].find((x) => x.textContent?.trim() === t)
  b?.click()
  return !!b
}, t, within)
const toastText = () => page.evaluate(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent?.replace(/\s+/g, ' ').trim()))

await fresh()

// ---- chrome budget
await shot('board-1440')
const toolbar = await page.evaluate(() => {
  const bar = document.querySelector('[data-testid=toolbar]')!
  const r = bar.getBoundingClientRect()
  const controls = [...bar.querySelectorAll('input, select, button')].filter((e) => !e.closest('[data-testid=summary], h1') && !(e as HTMLElement).dataset.filter && (e as HTMLElement).dataset.testid !== 'clear-filters' && !(e as HTMLElement).closest('[role=group]'))
  return { height: Math.round(r.height), controls: controls.map((c) => (c.getAttribute('aria-label') ?? c.textContent ?? '').trim()), seg: bar.querySelectorAll('[data-seg]').length }
})
check('toolbar is one row (≤ 56px tall)', toolbar.height <= 56, toolbar.height)
check('toolbar controls: Search, Filter, Sort, Board|List, New ticket', toolbar.controls.join('|') === 'Search tickets|Filter|Sort|New ticket' && toolbar.seg === 2, toolbar)
for (const gone of ['[data-testid=keyboard-hint]', '[data-seg=compact]', '[data-seg=detailed]', '[data-testid=toggle-dropped]', '[data-filter=quick]']) {
  check(`removed: ${gone}`, (await count(gone)) === 0)
}
check('no Insights button', !(await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => /insights/i.test(b.textContent ?? '')))))
const title0 = await text('[data-testid=summary]')
check('title line has the ticket count', /\d+ tickets?/.test(title0 ?? ''), title0)
const nums = async () => page.evaluate(() => Object.fromEntries(['urgent', 'blocked', 'later'].map((k) => [k, document.querySelector(`[data-filter=${k}]`)?.textContent?.trim() ?? null])))
const t0 = await nums()
check('urgent / blocked / later toggles exist with counts', Object.values(t0).every((v) => v && /^\d+ /.test(v)), t0)

// ---- filters in the title line
const urgentCards = () => page.$$eval('[data-card-id][data-urgent]', (e) => e.length)
const urgentTotal = Number((t0.urgent ?? '').split(' ')[0])
await page.click('[data-filter=urgent]'); await sleep(300)
check('urgent toggle: aria-pressed on', (await pressed('[data-filter=urgent]')) === true)
const onStyle = await page.$eval('[data-filter=urgent]', (e) => ({ deco: getComputedStyle(e).textDecorationLine, color: getComputedStyle(e).color, base: getComputedStyle(document.body).color }))
check('urgent toggle: underlined + coloured', onStyle.deco === 'underline' && onStyle.color !== onStyle.base, onStyle)
const shown = await count('[data-card-id]')
check('board shows only the urgent cards', shown === (await urgentCards()) && shown > 0, { shown, urgentTotal })
check('title reads "N of M tickets"', /of \d+ tickets/.test((await text('[data-testid=summary]')) ?? ''), await text('[data-testid=summary]'))
check('blocked count unchanged while urgent is on', (await nums()).blocked === t0.blocked, await nums())
await shot('title-urgent-on')
await page.click('[data-filter=blocked]'); await sleep(300)
check('urgent + blocked narrows further', (await count('[data-card-id]')) <= shown, await count('[data-card-id]'))
await page.click('[data-filter=blocked]'); await page.click('[data-filter=urgent]'); await sleep(300)
check('toggling both off restores the board', (await pressed('[data-filter=urgent]')) === false && (await count('[data-card-id]')) > shown)
const laterBefore = await page.$eval('[data-testid=later-todo]', (e) => e.getAttribute('aria-expanded'))
await page.click('[data-filter=later]'); await sleep(300)
const laterAfter = await page.$$eval('[data-testid^=later-]', (e) => e.map((x) => x.getAttribute('aria-expanded')))
check('later toggle opens both Later lists', laterBefore === 'false' && laterAfter.every((v) => v === 'true') && (await pressed('[data-filter=later]')) === true, laterAfter)
await page.click('[data-filter=later]'); await sleep(200)

// ---- Filter popover
await page.click('[data-testid=filter]'); await sleep(300)
await shot('filter-popover-1440')
const pop = await text('[data-testid=filter-popover]')
check('Filter popover has Category, Assignee, Quick wins, Show dropped', ['Category', 'Assignee', 'Quick wins only', 'Show dropped'].every((w) => pop?.includes(w)), pop)
await page.click('[data-testid=filter-quick]'); await sleep(300)
check('Quick wins only: every visible card has the quick word', await page.evaluate(() => { const c = [...document.querySelectorAll('[data-card-id]')]; return c.length > 0 && c.every((x) => x.querySelector('[data-payoff=quick]')) }))
check('Filter button shows a count badge', (await text('[data-testid=filter-count]')) === '1')
await page.click('[data-testid=filter-quick]'); await sleep(200)
await page.click('[data-testid=filter-dropped]'); await sleep(300)
check('Show dropped adds the Dropped column', (await count('[data-column=dropped]')) === 1)
await page.click('[data-testid=filter-dropped]'); await sleep(200)
await page.keyboard.press('Escape'); await sleep(200)

// ---- undo toasts on key actions
const focusFirst = async (state: string) => {
  await page.keyboard.press('Escape')
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('j'); await sleep(60)
    const s = await page.evaluate(() => { const f = document.querySelector('.kb-focus')
    if (!f) return null
    const x = f.getBoundingClientRect().x + 4
    return [...document.querySelectorAll('[data-column]')].find((h) => { const r = h.getBoundingClientRect(); return x >= r.x - 8 && x <= r.right })?.getAttribute('data-column') ?? null })
    if (s === state) return true
  }
  return false
}
await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
await page.keyboard.press('Escape')
const okFocus = await focusFirst('proposed')
check('j focuses a Proposed card', okFocus, okFocus ? undefined : await page.evaluate(() => ({ kb: document.querySelectorAll('.kb-focus').length, dialogs: [...document.querySelectorAll('[role=dialog]')].map((d) => d.outerHTML.slice(0, 120)), ae: document.activeElement?.outerHTML.slice(0, 120) })))
const focused = await page.evaluate(() => (document.querySelector('.kb-focus [data-card-id]') as HTMLElement | null)?.dataset.cardId ?? null)
await resetLog()
await page.keyboard.press('l'); await sleep(500)
let w = await writes()
check('l: PATCH later=true', w.length === 1 && w[0].method === 'PATCH' && w[0].body?.later === true, w.map((x) => [x.method, x.path, x.body]))
check('l: toast with Undo', (await toastText()).some((t) => /shelved under Later/.test(t ?? '') && /Undo/.test(t ?? '')), await toastText())
await shot('toast-later-1440')
await resetLog()
await clickText('Undo'); await sleep(500)
w = await writes()
check('l undo: PATCH later=false', w.length === 1 && w[0].body?.later === false, w.map((x) => [x.method, x.path, x.body]))
await page.evaluate(() => document.querySelectorAll('[data-sonner-toast]').forEach((t) => t.remove())); await sleep(200)

// a
await page.keyboard.press('Escape')
await focusFirst('proposed')
await resetLog()
await page.keyboard.press('a'); await sleep(500)
w = await writes()
check('a: PATCH state=todo', w.length === 1 && w[0].body?.state === 'todo', w.map((x) => [x.method, x.path, x.body]))
check('a: toast with Undo', (await toastText()).some((t) => /accepted/.test(t ?? '') && /Undo/.test(t ?? '')), await toastText())
await resetLog()
await clickText('Undo'); await sleep(500)
w = await writes()
check('a undo: PATCH state=proposed', w.length === 1 && w[0].body?.state === 'proposed', w.map((x) => [x.method, x.path, x.body]))
await page.evaluate(() => document.querySelectorAll('[data-sonner-toast]').forEach((t) => t.remove())); await sleep(200)

// u (urgent) and 2 (return)
await page.keyboard.press('Escape')
await focusFirst('proposed')
await resetLog()
await page.keyboard.press('u'); await sleep(500)
w = await writes()
const u0 = w[0]?.body?.urgent
check('u: PATCH urgent + Undo toast', w.length === 1 && typeof u0 === 'boolean' && (await toastText()).some((t) => /urgent/.test(t ?? '') && /Undo/.test(t ?? '')), w.map((x) => [x.path, x.body]))
await resetLog()
await clickText('Undo'); await sleep(500)
w = await writes()
check('u undo: PATCH urgent back', w.length === 1 && w[0].body?.urgent === !u0, w.map((x) => [x.path, x.body]))
await page.evaluate(() => document.querySelectorAll('[data-sonner-toast]').forEach((t) => t.remove())); await sleep(200)
await resetLog()
await page.keyboard.press('Digit2'); await sleep(500)
w = await writes()
check('2: PATCH impact=medium + Undo toast', w.length === 1 && w[0].body?.impact === 'medium' && (await toastText()).some((t) => /return/.test(t ?? '') && /Undo/.test(t ?? '')), w.map((x) => [x.path, x.body]))
await resetLog()
await clickText('Undo'); await sleep(500)
w = await writes()
check('2 undo: PATCH impact back', w.length === 1 && 'impact' in (w[0].body ?? {}) && w[0].body?.impact !== 'medium' || w[0]?.body?.impact === null, w.map((x) => [x.path, x.body]))
await page.evaluate(() => document.querySelectorAll('[data-sonner-toast]').forEach((t) => t.remove()))
await page.keyboard.press('Escape')
void focused

// ---- ? sheet
await page.keyboard.press('?'); await sleep(400)
const sheet = await text('[data-testid=shortcut-sheet]')
check('? opens the shortcut sheet listing every key', !!sheet && ['Search', 'New ticket', 'Triage', 'Accept', 'Later', 'Drop', 'urgent', 'Return', 'Effort'].every((w) => sheet.includes(w)), sheet?.slice(0, 120))
await shot('shortcut-sheet-1440')
await page.keyboard.press('Escape'); await sleep(300)
check('Esc closes the sheet', (await count('[data-testid=shortcut-sheet]')) === 0)

// ---- t enters Triage
await resetLog()
await page.keyboard.press('t'); await sleep(600)
check('t replaces the board with Triage', (await count('[data-testid=toolbar]')) === 0 && (await count('[data-column=todo]')) === 0)
await shot('triage-entered-1440')
check('entering Triage writes nothing', (await writes()).length === 0)
await page.keyboard.press('j'); await page.keyboard.press('/'); await page.keyboard.press('n'); await sleep(300)
check('board keys are off in Triage (/ and n do nothing here)', (await count('[role=dialog]')) === 0 && (await count('[data-testid=search]')) === 0)
await page.keyboard.press('?'); await sleep(300)
check('? still opens the sheet inside Triage', (await count('[data-testid=shortcut-sheet]')) === 1)
await page.keyboard.press('Escape'); await sleep(300)
await page.keyboard.press('Escape'); await sleep(500)
check('Esc leaves Triage', (await count('[data-testid=toolbar]')) === 1)

// ---- Proposed count opens Triage (needs @rail's header wiring)
const countBtn = await page.$('[data-column=proposed] [data-testid=triage-count], [data-triage-open]')
if (countBtn) {
  await countBtn.click(); await sleep(500)
  check('clicking the Proposed count opens Triage', (await count('[data-testid=toolbar]')) === 0)
  await page.keyboard.press('Escape'); await sleep(400)
} else console.log('SKIP  Proposed count button not found (selector [data-triage-open])')

// ---- older Done → List filtered to Done
const older = await page.evaluate(() => { const b = [...document.querySelectorAll<HTMLElement>('button, a')].find((x) => /older/.test(x.textContent ?? '')); b?.click(); return !!b })
await sleep(500)
if (older) {
  check('"N older" opens the List filtered to Done', (await count('[data-seg=list][aria-pressed=true]')) === 1 && (await count('[data-testid=state-filter]')) === 1, await text('[data-testid=state-filter]'))
  await shot('list-done-1440')
  await page.click('[data-testid=state-filter]'); await sleep(300)
  check('state filter pill clears', (await count('[data-testid=state-filter]')) === 0)
  await page.click('[data-seg=board]'); await sleep(300)
} else console.log('SKIP  "N older" link not found (needs @rail)')

// ---- 1280x800
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
await sleep(400)
await shot('board-1280')
const h1280 = await page.$eval('[data-testid=toolbar]', (e) => Math.round(e.getBoundingClientRect().height))
check('toolbar is still one row at 1280', h1280 <= 56, h1280)
await page.click('[data-testid=filter]'); await sleep(300)
await shot('filter-popover-1280')
await page.keyboard.press('Escape')
await page.click('[data-filter=blocked]'); await sleep(300)
await shot('title-blocked-1280')
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
check('no horizontal page overflow at 1280', overflow <= 0, overflow)

check('no console errors', errors.length === 0, errors.slice(0, 3))
await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
