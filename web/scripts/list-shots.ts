#!/usr/bin/env bun
// List and new-ticket dialog screenshot + request-body proof against the v2 mock.
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
  const insights = await page.$('[data-testid="insights"]')
  if (insights) {
    await insights.click()
    await page.waitForSelector('[data-testid="insights-popover"], [data-testid="insights-panel"]', { timeout: 5000 })
    await sleep(300)
    await page.screenshot({ path: join(OUT, `insights-${width}.png`) })
    console.log(`shot insights-${width}.png`)
    await page.keyboard.press('Escape')
    await sleep(150)
  }
}

for (const [width, height] of [[1440, 900], [1280, 800]] as const) {
  await openList(width, height)
  await page.click('[data-testid="new-ticket"]')
  await page.waitForSelector('[data-testid="new-ticket-dialog"]', { timeout: 5000 })
  await sleep(250)
  const headerBounds = await page.$eval('[data-slot="dialog-header"]', (el) => {
    const rect = el.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, height: rect.height }
  })
  const footerBounds = await page.$eval('[data-slot="dialog-footer"]', (el) => {
    const rect = el.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, height: rect.height }
  })
  const submitBounds = await page.$eval('[data-testid="new-ticket-submit"]', (el) => {
    const rect = el.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, height: rect.height }
  })
  const bodyMetrics = await page.$eval('[data-testid="new-ticket-body"]', (el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop }))
  if (headerBounds.top < 0 || footerBounds.height < 40 || submitBounds.height < 30 || submitBounds.bottom > height - 1 || footerBounds.bottom > height - 1) {
    throw new Error(`Dialog header or footer is clipped at ${width}×${height}: ${JSON.stringify({ headerBounds, footerBounds, submitBounds })}`)
  }
  if (bodyMetrics.scrollHeight > bodyMetrics.clientHeight) {
    await page.$eval('[data-testid="new-ticket-body"]', (el) => { el.scrollTop = el.scrollHeight })
    await page.waitForFunction(() => {
      const body = document.querySelector('[data-testid="new-ticket-body"]') as HTMLElement | null
      return !!body && body.scrollTop > 0
    })
    const footerAfterScroll = await page.$eval('[data-slot="dialog-footer"]', (el) => el.getBoundingClientRect().bottom)
    if (Math.abs(footerAfterScroll - footerBounds.bottom) > 1) throw new Error(`Dialog footer moved while scrolling body at ${width}×${height}`)
    await page.$eval('[data-testid="new-ticket-body"]', (el) => { el.scrollTop = 0 })
  }
  dialogProof.push(`${width}×${height}: header/footer in view; body ${bodyMetrics.clientHeight}px / ${bodyMetrics.scrollHeight}px`)
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
await page.type('#new-ticket-title', 'Add a quarterly export preset')
await page.type('#new-ticket-category', 'finance')
await page.type('#new-ticket-estimate', '90m')
await page.click('[role="switch"]')
await page.click('#new-ticket-impact')
await page.waitForSelector('[role="option"]')
await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent?.trim() === 'High')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
await page.click('#new-ticket-effort')
await page.waitForSelector('[role="option"]')
await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent?.trim() === 'Low')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
await page.type('#new-ticket-tags', 'finance')
await page.keyboard.press('Enter')
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
