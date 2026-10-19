#!/usr/bin/env bun
// Card face screenshots (2x crops of representative cards, tooltips, keyboard focus ring) against the mock or a vite dev server.
//   bun scripts/face-a-shots.ts [--url http://localhost:5181] [--out ../.orchestra/shots/final] [--project plutus]
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer from 'puppeteer-core'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' }, out: { type: 'string' }, project: { type: 'string' } } })
const URL_ = values.url ?? 'http://127.0.0.1:5181'
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.orchestra/shots/final'))
const PROJECT = values.project ?? 'plutus'
const FACE = 'face'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })
const page = await browser.newPage()
const errors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
await page.goto(`${URL_}/#/board?p=${PROJECT}`, { waitUntil: 'networkidle2' }).catch(() => {})
await page.waitForSelector('[data-card-id]', { timeout: 8000 }).catch(async (e) => {
  console.error('no cards; console errors:', errors, (await page.evaluate(() => document.body.innerText)).slice(0, 200))
  throw e
})
await sleep(500)
const click = async (sel: string) => { await page.click(sel); await sleep(350) }
const shot = async (name: string) => { await page.screenshot({ path: join(OUT, `${FACE}-${name}.png`) }); console.error(`shot ${FACE}-${name}.png`) }

await click('[data-seg=compact]')
await shot('board-compact')
await click('[data-seg=detailed]')
await shot('board-detailed')
await click('[data-seg=compact]')
await click('[data-testid=later-todo]')
await click('[data-testid=later-proposed]')
await page.evaluate(() => document.querySelectorAll('[data-later-line]').forEach((e) => e.scrollIntoView({ block: 'center' })))
await sleep(300)
await shot('board-later')
await click('[data-testid=later-todo]')
await click('[data-testid=later-proposed]')
await page.evaluate(() => document.querySelectorAll('.overflow-y-auto').forEach((e) => { e.scrollTop = 0 }))

await click('[data-testid=later-todo]')
// 2x crop: one representative card of each kind, compact and detailed, laid side by side from the live DOM.
const cropOf = async (name: string) => {
  const cards = await page.evaluate(() => {
    const all = [...document.querySelectorAll<HTMLElement>('[data-card-id]')]
    const ids = new Set<string>()
    const add = (el?: Element | null) => { const id = el?.getAttribute('data-card-id'); if (id) ids.add(id) }
    add(all.find((e) => e.dataset.urgent && e.dataset.blocked === undefined))
    add(all.find((e) => e.dataset.blocked !== undefined && !e.dataset.urgent))
    add(all.find((e) => e.dataset.urgent && e.dataset.blocked !== undefined))
    add(all.find((e) => e.querySelector('[data-payoff=quick]') && !e.dataset.urgent && e.dataset.blocked === undefined))
    add(all.find((e) => e.querySelector('[aria-label=Done]')))
    add(all.find((e) => e.dataset.later))
    add(all.find((e) => !e.dataset.urgent && e.dataset.blocked === undefined && !e.dataset.later && !e.querySelector('[data-payoff]') && !e.querySelector('[aria-label=Done]')))
    add(all.find((e) => e.querySelector('[data-payoff=bet],[data-payoff=heavy],[data-payoff=pit]')))
    return [...ids]
  })
  // Clone the chosen cards into a fixed-width white sheet so one clip captures them all.
  await page.evaluate((ids) => {
    document.getElementById('face-crop')?.remove()
    const wrap = document.createElement('div')
    wrap.id = 'face-crop'
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#f4f4f5;display:grid;grid-template-columns:repeat(4,300px);gap:12px;padding:16px;align-content:start;justify-content:start'
    for (const id of ids) {
      const src = document.querySelector(`[data-card-id="${id}"]`)!
      const host = src.parentElement!
      const clone = host.cloneNode(true) as HTMLElement
      clone.style.cssText = 'border:1px solid #e4e4e7;border-radius:8px;background:white;overflow:hidden'
      clone.querySelectorAll('[data-quick-actions]').forEach((q) => q.remove())
      wrap.appendChild(clone)
    }
    document.body.appendChild(wrap)
  }, cards)
  await sleep(300)
  const box = await page.evaluate(() => { const kids = [...document.getElementById('face-crop')!.children]; const bottom = Math.max(...kids.map((k) => k.getBoundingClientRect().bottom)); return { x: 0, y: 0, width: 1264, height: Math.min(900, Math.ceil(bottom + 16)) } })
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  await page.screenshot({ path: join(OUT, `${FACE}-${name}.png`), clip: box })
  console.error(`shot ${FACE}-${name}.png (${cards.length} cards)`)
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.evaluate(() => document.getElementById('face-crop')?.remove())
}
await cropOf('zoom-compact')
await click('[data-seg=detailed]')
await sleep(300)
await cropOf('zoom-detailed')
// Keyboard focus ring (j walks the board) on an urgent card and on a blocked one.
await page.evaluate(() => document.querySelectorAll('.overflow-y-auto').forEach((e) => { e.scrollTop = 0 }))
await page.mouse.move(2, 2)
await page.keyboard.press('j')
for (const [name, rail] of [['focus-ring-urgent', 'urgent'], ['focus-ring-blocked', 'blocked']] as const) {
  for (let i = 0; i < 40 && !(await page.$(`.kb-focus [data-rail=${rail}]`)); i++) { await page.keyboard.press('j'); await sleep(80) }
  await sleep(300)
  const box = await page.evaluate(() => { const r = document.querySelector('.kb-focus')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null })
  if (box) await page.screenshot({ path: join(OUT, `${FACE}-${name}.png`), clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 20), width: box.width + 48, height: box.height + 40 } })
  console.error(`shot ${FACE}-${name}.png`, box ? '' : '(no focused card)')
}
await page.keyboard.press('Escape')
// Rail + payoff tooltips on hover.
await click('[data-seg=compact]')
for (const [name, sel] of [['tip-rail-both', '[data-rail=both]'], ['tip-rail-blocked', '[data-rail=blocked]'], ['tip-payoff', '[data-payoff=quick]']] as const) {
  const el = await page.$(sel)
  if (!el) continue
  await el.scrollIntoView()
  await el.hover()
  await sleep(700)
  const b = await el.boundingBox()
  await page.screenshot({ path: join(OUT, `${FACE}-${name}.png`), clip: { x: Math.max(0, b!.x - 20), y: Math.max(0, b!.y - 40), width: 420, height: 130 } })
  console.error(`shot ${FACE}-${name}.png`)
  await page.mouse.move(2, 2)
}
console.log(JSON.stringify({ errors }))
await browser.close()
