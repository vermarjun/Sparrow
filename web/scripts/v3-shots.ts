#!/usr/bin/env bun
// Board v3 screenshots: board, list, peek, empty columns, Later line, Done cap at 1440x900 and 1280x800.
//   bun scripts/v3-shots.ts [--url http://localhost:5181] [--out ../.orchestra/shots/v3] [--project plutus] [--empty-project sparrow]
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer from 'puppeteer-core'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' }, out: { type: 'string' }, project: { type: 'string' }, 'empty-project': { type: 'string' } } })
const URL_ = values.url ?? 'http://localhost:5181'
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.orchestra/shots/v3'))
const PROJECT = values.project ?? 'plutus'
const EMPTY = values['empty-project'] ?? 'sparrow'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })
const errors: string[] = []
const report: Record<string, unknown> = {}

for (const [w, h] of [[1440, 900], [1280, 800]]) {
  const tag = `${w}x${h}`
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 })
  const go = async (project: string, hash = 'board') => {
    await page.goto(`${URL_}/#/${hash}?p=${project}`, { waitUntil: 'networkidle2' }).catch(() => {})
    await page.waitForSelector('[data-card-id], [data-empty]', { timeout: 8000 })
    await sleep(500)
  }
  const shot = async (name: string, clip?: { x: number; y: number; width: number; height: number }) => {
    await page.screenshot({ path: join(OUT, `${tag}-${name}.png`), ...(clip ? { clip } : {}) })
    console.error(`shot ${tag}-${name}.png`)
  }
  const click = async (sel: string) => { await page.click(sel); await sleep(400) }

  await go(PROJECT)
  await shot('board')
  // Done cap: the Done column with its "N older" link.
  report[`${tag}.doneOlder`] = await page.$eval('[data-testid=done-older]', (e) => e.textContent).catch(() => null)
  const doneBox = await page.evaluate(() => { const r = document.querySelector('[data-column=done]')?.parentElement?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null })
  if (doneBox) await shot('done-cap', { x: doneBox.x - 12, y: doneBox.y - 8, width: doneBox.width + 24, height: Math.min(doneBox.height + 16, h - doneBox.y) })
  // Count tooltip on Proposed, and on Done (the one-line insight).
  for (const col of ['proposed', 'done']) {
    await page.hover(`[data-count=${col}], [data-column=${col}] [data-testid=triage-count]`).catch(() => {})
    await sleep(700)
    const b = await page.evaluate((c) => { const r = (document.querySelector(`[data-count=${c}]`) ?? document.querySelector(`[data-column=${c}] [data-testid=triage-count]`))?.getBoundingClientRect(); return r ? { x: r.x, y: r.y } : null }, col)
    if (b) await shot(`count-tip-${col}`, { x: Math.max(0, b.x - 150), y: Math.max(0, b.y - 110), width: 340, height: 150 })
    await page.mouse.move(2, 2)
  }
  // Peek: hover a card with checks / a blocker for 700ms.
  const peekId = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-card-id]')].find((e) => e.dataset.blocked !== undefined)?.dataset.cardId ?? document.querySelector<HTMLElement>('[data-card-id]')?.dataset.cardId)
  await page.hover(`[data-card-id="${peekId}"]`)
  await sleep(300)
  report[`${tag}.peekAt300ms`] = !!(await page.$('[data-peek]'))
  await sleep(500)
  report[`${tag}.peekAt800ms`] = !!(await page.$('[data-peek]'))
  await shot('peek')
  await page.mouse.move(2, 2)
  await sleep(400)
  report[`${tag}.peekClosed`] = !(await page.$('[data-peek]'))
  // Peek from the keyboard: j focuses the first card, Space pins the peek, Space again closes it.
  await page.keyboard.press('j')
  await sleep(200)
  await page.keyboard.press('Space')
  await sleep(400)
  report[`${tag}.peekSpace`] = !!(await page.$('[data-peek]'))
  await shot('peek-keyboard')
  await page.keyboard.press('Space')
  await sleep(300)
  report[`${tag}.peekSpaceOff`] = !(await page.$('[data-peek]'))
  await page.keyboard.press('Escape')
  // Lift while dragging: pick a To do card up and hold it over Review.
  const drag = await page.evaluate(() => { const r = document.querySelector('[data-column=todo]')?.parentElement?.querySelector('[data-card-id]')?.getBoundingClientRect(); const t = document.querySelector('[data-column=review]')?.getBoundingClientRect(); return r && t ? { x: r.x + r.width / 2, y: r.y + 20, tx: t.x + t.width / 2, ty: t.y + 200 } : null })
  if (drag) {
    await page.mouse.move(drag.x, drag.y)
    await page.mouse.down()
    for (let i = 1; i <= 20; i++) { await page.mouse.move(drag.x + ((drag.tx - drag.x) * i) / 20, drag.y + ((drag.ty - drag.y) * i) / 20); await sleep(16) }
    await sleep(250)
    await shot('dragging')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await sleep(500)
  }
  // FLIP: accepting a proposal moves its card to To do; the card (and the ones below it) must animate.
  const flipBefore = await page.evaluate(() => document.getAnimations().length)
  await page.evaluate(() => (document.querySelector('[data-column=proposed]')?.parentElement?.querySelector('[data-action="Accept to To do"]') as HTMLElement | null)?.click())
  await sleep(60)
  report[`${tag}.flipAnimations`] = (await page.evaluate(() => document.getAnimations().filter((a) => a instanceof Animation && (a.effect as KeyframeEffect | null)?.getKeyframes?.().some((k) => 'transform' in k)).length)) - flipBefore
  await sleep(500)
  // Later line, expanded.
  await click('[data-testid=later-todo]')
  await click('[data-testid=later-proposed]')
  await page.evaluate(() => document.querySelectorAll('[data-later-line]').forEach((e) => e.scrollIntoView({ block: 'center' })))
  await sleep(300)
  await shot('later')
  await click('[data-testid=later-todo]')
  await click('[data-testid=later-proposed]')
  // List.
  await click('[data-seg=list]')
  await sleep(400)
  await shot('list')
  report[`${tag}.listColumns`] = await page.$$eval('[data-testid=board-list] thead [data-sort-key]', (e) => e.map((b) => b.getAttribute('data-sort-key')))
  await click('[data-seg=board]')
  // Empty columns: a project with a single ticket.
  await go(EMPTY)
  await shot('empty-columns')
  report[`${tag}.emptyCopy`] = await page.$$eval('[data-empty]', (e) => e.map((p) => p.textContent))
  await page.close()
}
console.log(JSON.stringify({ errors, ...report }, null, 2))
await browser.close()
