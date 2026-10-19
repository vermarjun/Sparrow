#!/usr/bin/env bun
// Captain page screenshots + checks against the mock (stable: start the mock with --no-live) served through vite.
//   bun scripts/captain-page-shots.ts --url http://127.0.0.1:5282 [--out ../.orchestra/shots/captains] [--project plutus]
//   bun scripts/captain-page-shots.ts --url http://127.0.0.1:5282 --live   (mock WITH live ticks, e.g. MOCK_TICK_MS=2500:
//     appends must not move the header/tabs, scrolled-up readers get "Jump to latest")
// Prints a JSON summary: console errors, page errors, horizontal-scroll checks, live-tick measurements.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer, { type Page } from 'puppeteer-core'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' }, out: { type: 'string' }, project: { type: 'string' }, live: { type: 'boolean' } } })
const URL_ = values.url ?? 'http://127.0.0.1:5282'
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.orchestra/shots/captains'))
const PROJECT = values.project ?? 'plutus'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
mkdirSync(OUT, { recursive: true })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const consoleErrors: string[] = []
const pageErrors: string[] = []
const scrollChecks: { shot: string; scrollWidth: number; clientWidth: number }[] = []

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })

async function open(theme: 'light' | 'dark', w: number, h: number): Promise<Page> {
  const page = await browser.newPage()
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument((t) => { try { localStorage.setItem('sparrow.theme', t) } catch { /* */ } }, theme)
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${theme} ${w}] ${m.text()}`) })
  page.on('pageerror', (e) => pageErrors.push(`[${theme} ${w}] ${String(e)}`))
  return page
}
const go = async (page: Page, hash: string) => {
  await page.goto(`${URL_}/#/${hash}${hash.includes('?') ? '&' : '?'}p=${PROJECT}`, { waitUntil: 'networkidle2' }).catch(() => {})
  await page.waitForSelector('[role=tablist]', { timeout: 8000 }).catch(() => {})
  await sleep(900)
}
const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  const m = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))
  scrollChecks.push({ shot: name, ...m })
  console.error(`shot ${name}.png (scrollWidth ${m.scrollWidth}/${m.clientWidth})`)
}

if (values.live) {
  const page = await open('light', 1440, 900)
  await go(page, 'captain/ag_cap')
  const boxes = () => page.evaluate(() => {
    const r = (sel: string) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b ? [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] : null }
    const feed = document.querySelector('[data-testid=feed]') as HTMLElement
    return { title: r('[data-testid=title]'), stats: r('[data-testid=stats]'), tabs: r('[role=tablist]'), feedBox: r('[data-testid=feed]'), scrollHeight: feed.scrollHeight, scrollTop: Math.round(feed.scrollTop), atBottom: feed.scrollHeight - feed.scrollTop - feed.clientHeight < 4 }
  })
  const before = await boxes()
  await sleep(8000)
  const after = await boxes()
  // Scrolled-up reader: scroll to top, wait for another tick, the pill appears and scrollTop stays.
  await page.evaluate(() => { (document.querySelector('[data-testid=feed]') as HTMLElement).scrollTop = 0 })
  await sleep(300)
  const top0 = await boxes()
  await sleep(8000)
  const top1 = await boxes()
  const pill = await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => /Jump to latest/.test(b.textContent ?? '')))
  await shot(page, 'live-jump-pill')
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const out = {
    pinnedReader: { before, after, headerStable: same(before.title, after.title) && same(before.stats, after.stats) && same(before.tabs, after.tabs) && same(before.feedBox, after.feedBox), scrollHeightGrew: after.scrollHeight - before.scrollHeight, stayedAtBottom: after.atBottom },
    scrolledUpReader: { scrollTopBefore: top0.scrollTop, scrollTopAfter: top1.scrollTop, scrollHeightGrew: top1.scrollHeight - top0.scrollHeight, jumpPillShown: pill, headerStable: same(top0.tabs, top1.tabs) && same(top0.stats, top1.stats) },
    consoleErrors, pageErrors,
  }
  console.log(JSON.stringify(out, null, 2))
  await browser.close()
  process.exit(0)
}

for (const theme of ['light', 'dark'] as const) {
  const page = await open(theme, 1440, 900)
  const s = (n: string) => `${n}-${theme}`
  await go(page, 'captain/ag_cap')
  await shot(page, s('captain-activity'))
  await go(page, 'captain/ag_orion')
  await shot(page, s('captain-activity-orion'))
  await go(page, 'captain/ag_orion?tab=team')
  await shot(page, s('captain-team'))
  await go(page, 'captain/ag_orion?agent=ag_zoe')
  await sleep(1200)
  await shot(page, s('agent-sheet'))
  await go(page, 'captain/ag_cap?agent=ag_iris')
  await sleep(1200)
  await shot(page, s('agent-sheet-crashed'))
  await go(page, 'captain/ag_cap?tab=cards')
  await shot(page, s('captain-cards'))
  await go(page, 'captain/ag_altair')
  await shot(page, s('captain-untitled'))
  await go(page, 'captain/ag_altair?tab=team')
  await shot(page, s('captain-untitled-team'))
  await go(page, 'captain/ag_orion')
  await page.click('[data-testid=title]')
  await sleep(300)
  await shot(page, s('captain-title-edit'))
  await go(page, 'captain/ag_orion')
  await page.click('[data-testid=resume-menu]')
  await sleep(400)
  await shot(page, s('captain-resume-menu'))
  await page.close()

  const m = await open(theme, 390, 844)
  await go(m, 'captain/ag_cap')
  await shot(m, s('mobile-captain-activity'))
  await go(m, 'captain/ag_cap?tab=team')
  await shot(m, s('mobile-captain-team'))
  await go(m, 'captain/ag_orion?agent=ag_zoe')
  await sleep(1200)
  await shot(m, s('mobile-agent-sheet'))
  await m.close()
}

console.log(JSON.stringify({ consoleErrors, pageErrors, scrollChecks: scrollChecks.filter((c) => c.shot.startsWith('mobile')), overflow: scrollChecks.filter((c) => c.scrollWidth > c.clientWidth) }, null, 2))
await browser.close()
