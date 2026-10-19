#!/usr/bin/env bun
// List and quick-create dialog (title + chips, Add details) screenshot + request-body proof against the v2 mock.
// Usage: bun scripts/list-shots.ts [--url http://localhost:5173] [--mock http://localhost:4140] [--project plutus]
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer from 'puppeteer-core'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' }, mock: { type: 'string' }, project: { type: 'string' }, out: { type: 'string' } } })
const URL = values.url ?? 'http://localhost:5173'
const MOCK = values.mock ?? 'http://localhost:4140'
const PROJECT = values.project ?? 'plutus'
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.orchestra/shots/board-v2'))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
mkdirSync(OUT, { recursive: true })

const errors: { console: string[]; page: string[] } = { console: [], page: [] }
const sortProof: string[] = []
const dialogProof: string[] = []
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })
const page = await browser.newPage()
page.on('console', (message) => { if (message.type() === 'error') errors.console.push(message.text()) })
page.on('pageerror', (error) => errors.page.push(String(error)))

const openList = async (width: number, height: number) => {
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  await page.goto(`${URL}/#/board?p=${PROJECT}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="toolbar"]', { timeout: 15000 })
  const listButton = await page.$('[data-seg="list"]')
  if (!listButton) throw new Error('Board view toggle is missing')
  await listButton.click()
  await page.waitForSelector('[data-testid="board-list"]', { timeout: 8000 })
  await page.waitForSelector('[data-list-row]', { timeout: 8000 })
  await sleep(300)
  await page.screenshot({ path: join(OUT, `list-${width}.png`) })
  console.log(`shot list-${width}.png`)
  const titleSort = await page.$('button[data-sort-key="title"]')
  if (!titleSort) throw new Error('List title sort header is missing')
  await titleSort.click()
  const firstDirection = await titleSort.evaluate((el) => el.getAttribute('aria-sort'))
  await titleSort.click()
  const secondDirection = await titleSort.evaluate((el) => el.getAttribute('aria-sort'))
  if (firstDirection === secondDirection || !firstDirection || !secondDirection) throw new Error('List title sort did not toggle')
  sortProof.push(`${width}: ${firstDirection} → ${secondDirection}`)
}

for (const [width, height] of [[1440, 900], [1280, 800]] as const) {
  await openList(width, height)
  await page.click('[data-testid="new-ticket"]')
  await page.waitForSelector('[data-testid="new-ticket-dialog"]', { timeout: 5000 })
  await sleep(250)
  const boundsOf = (sel: string) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height } })
  const dialogBounds = await boundsOf('[data-testid="new-ticket-dialog"]')
  const footerBounds = await boundsOf('[data-testid="new-ticket-dialog"] footer')
  const submitBounds = await boundsOf('[data-testid="new-ticket-submit"]')
  const bodyMetrics = await page.$eval('[data-testid="new-ticket-body"]', (el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop }))
  if (dialogBounds.top < 0 || footerBounds.height < 40 || submitBounds.height < 30 || submitBounds.bottom > height - 1 || footerBounds.bottom > height - 1) {
    throw new Error(`Dialog or its footer is clipped at ${width}×${height}: ${JSON.stringify({ dialogBounds, footerBounds, submitBounds })}`)
  }
  const headerBounds = dialogBounds
  void headerBounds
  // Quick create: the dialog starts small (title + chips); "Add details" expands the four sections and the footer stays put.
  const compact = bodyMetrics.scrollHeight <= bodyMetrics.clientHeight
  await page.click('[data-add-details]')
  await sleep(250)
  const footerOpen = await boundsOf('[data-testid="new-ticket-dialog"] footer')
  if (footerOpen.bottom > height - 1) throw new Error(`Dialog footer clipped after Add details at ${width}×${height}`)
  const bodyOpen = await page.$eval('[data-testid="new-ticket-body"]', (el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }))
  if (bodyOpen.scrollHeight > bodyOpen.clientHeight) {
    await page.$eval('[data-testid="new-ticket-body"]', (el) => { el.scrollTop = el.scrollHeight })
    await sleep(150)
    const footerAfterScroll = await boundsOf('[data-testid="new-ticket-dialog"] footer')
    if (Math.abs(footerAfterScroll.bottom - footerOpen.bottom) > 1) throw new Error(`Dialog footer moved while scrolling body at ${width}×${height}`)
    await page.$eval('[data-testid="new-ticket-body"]', (el) => { el.scrollTop = 0 })
  }
  await page.screenshot({ path: join(OUT, `dialog-${width}-details.png`) })
  await page.click('[data-add-details]')
  await sleep(200)
  dialogProof.push(`${width}×${height}: footer in view; collapsed body ${bodyMetrics.clientHeight}px / ${bodyMetrics.scrollHeight}px (fits: ${compact}); expanded ${bodyOpen.clientHeight}px / ${bodyOpen.scrollHeight}px`)
  await page.screenshot({ path: join(OUT, `dialog-${width}.png`) })
  await page.screenshot({ path: join(OUT, `${width}x${height}-new-ticket-dialog.png`) })
  console.log(`shot dialog-${width}.png`)
  await page.keyboard.press('Escape')
  await sleep(150)
}

// Exercise the form and prove the server received every field in the posted card body.
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
await page.click('[data-testid="new-ticket"]')
await page.waitForSelector('[data-testid="new-ticket-dialog"]')
await fetch(`${MOCK}/__log/reset`, { method: 'POST' })
const chipPopover = async (chip: string) => { await page.click(`[data-chip="${chip}"]`); await page.waitForSelector(`[data-popover="${chip}"]`); await sleep(200) }
await page.type('#new-ticket-title', 'Add a quarterly export preset')
await chipPopover('category')
await page.type('input[aria-label="Search or create a category"]', 'finance'); await sleep(200); await page.keyboard.press('Enter'); await sleep(200)
await page.click('[data-chip="urgent"]')
await chipPopover('return'); await page.click('[data-popover="return"] [data-level="high"]'); await sleep(200)
await chipPopover('effort'); await page.click('[data-popover="effort"] [data-level="low"]'); await sleep(200)
await chipPopover('estimate'); await page.keyboard.type('90m'); await page.keyboard.press('Enter'); await sleep(200)
await page.click('[data-add-details]')
await page.waitForSelector('[data-brief="context"]')
await page.type('[data-brief="context"]', 'Asked by finance during the quarterly planning review.')
await page.type('[data-brief="problem"]', 'Observed: the export range is re-entered each quarter. Expected: reuse a saved preset.')
await page.type('[data-brief="approach"]', 'Add one named preset and let users select it before export.')
await page.type('[data-brief="done-when"]', 'Quarter preset selects the correct dates.\nThe export includes the selected quarter.')
await page.keyboard.down('Meta')
await page.keyboard.press('Enter')
await page.keyboard.up('Meta')
await page.waitForFunction(() => !document.querySelector('[data-testid="new-ticket-dialog"]'), { timeout: 8000 })
await sleep(400)
const log = await fetch(`${MOCK}/__log`).then((res) => res.json()) as { method: string; path: string; body?: { card?: Record<string, unknown>; [key: string]: unknown } }[]
const post = log.find((entry) => entry.method === 'POST' && entry.path === '/api/cards')
const body = post?.body?.card ?? post?.body
const result = { out: OUT, dialogPost: body ?? null, sortProof, dialogProof, errors }
console.log(JSON.stringify(result, null, 2))
await browser.close()
if (!body || errors.console.length || errors.page.length) process.exitCode = 1
