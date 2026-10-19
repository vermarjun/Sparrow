#!/usr/bin/env bun
// Ticket sheet screenshots + proof that every edit path sends the right PATCH. Run against a dev server pointed at the mock:
//   bun mock/server.ts --port 4161 --no-live &  VITE_API=http://127.0.0.1:4161 bunx vite --port 5191 &
//   bun scripts/sheet-shots.ts [--url http://localhost:5191] [--out ../.orchestra/shots/board-v2] [--size 1440x900] [--no-proof]
// Prints JSON: console errors, page errors and the PATCH bodies each edit produced.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer from 'puppeteer-core'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { url: { type: 'string' }, out: { type: 'string' }, size: { type: 'string' }, project: { type: 'string' }, 'no-proof': { type: 'boolean' }, ids: { type: 'string' }, card: { type: 'string' }, prefix: { type: 'string' }, 'no-shots': { type: 'boolean' } },
})
const URL_ = values.url ?? 'http://localhost:5191'
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.orchestra/shots/board-v2'))
const PROJECT = values.project ?? 'plutus'
// ids: proposed,blocked,review,done,legacy (mock defaults); card: the one the edit proof mutates; prefix: shot file prefix
const [IP, IB, IR, ID, IL] = (values.ids ?? '18,21,4,27,14').split(',').map(Number)
const PROOF_CARD = Number(values.card ?? IP)
const PREFIX = values.prefix ?? ''
const [W, H] = (values.size ?? '1440x900').split('x').map(Number)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const consoleErrors: string[] = []
const pageErrors: string[] = []
const patches: { id: string; body: unknown }[] = []
const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })
const page = await browser.newPage()
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 })
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('response', async (r) => {
  if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()} ${(await r.text().catch(() => '')).slice(0, 200)}`)
})
page.on('request', (r) => {
  if (r.method() === 'PATCH') patches.push({ id: r.url().split('/').pop()!, body: JSON.parse(r.postData() ?? 'null') })
})
await page.evaluateOnNewDocument(() => {
  // Clipboard in headless: record what was copied.
  ;(window as unknown as { __copied: string[] }).__copied = []
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t: string) => { (window as unknown as { __copied: string[] }).__copied.push(t); return Promise.resolve() } } })
})

const sheet = '[data-ticket-sheet]'
async function openCard(id: number) {
  await page.goto(`${URL_}/#/board?p=${PROJECT}`, { waitUntil: 'networkidle2' }).catch(() => {})
  await page.waitForSelector('[data-card-id]', { timeout: 10000 }).catch(async (e) => {
    console.error('board did not render; page text:', (await page.evaluate(() => document.body.innerText)).slice(0, 300), '\nconsole:', consoleErrors, pageErrors)
    throw e
  })
  // A card may be in a collapsed Later group or hidden: open through the store-driven hash when click is not possible.
  const ok = await page.evaluate((cid) => {
    const el = document.querySelector(`[data-card-id="${cid}"]`) as HTMLElement | null
    el?.click()
    return !!el
  }, id)
  if (!ok) throw new Error(`card ${id} not on the board`)
  await page.waitForSelector(sheet, { timeout: 5000 })
  await sleep(500)
}
async function closeSheet() {
  await page.keyboard.press('Escape')
  await sleep(300)
}
const shot = async (name: string, scroll?: 'bottom' | 'mid') => {
  if (scroll) {
    await page.evaluate((s) => {
      const b = document.querySelector('[data-sheet-body]') as HTMLElement
      b.scrollTop = s === 'bottom' ? b.scrollHeight : b.scrollHeight / 2
    }, scroll)
    await sleep(250)
  }
  const file = `${PREFIX}sheet-${name}${scroll ? '-' + scroll : ''}-${W}x${H}.png`
  await page.screenshot({ path: join(OUT, file) })
  console.error('shot', file)
}
const lastPatch = () => patches.at(-1)
async function expectPatch(label: string, act: () => Promise<void>, results: Record<string, unknown>) {
  const n = patches.length
  await act()
  await sleep(450)
  results[label] = patches.slice(n).map((p) => p.body)
}
const clickSel = async (sel: string) => { await page.waitForSelector(sel, { timeout: 4000 }); await page.click(sel) }
const clickByText = async (tag: string, text: string, scope = sheet) => {
  const ok = await page.evaluate((t, x, sc) => {
    const root = document.querySelector(sc) ?? document
    const el = [...root.querySelectorAll(t)].find((e) => e.textContent?.trim() === x) as HTMLElement | undefined
    el?.click()
    return !!el
  }, tag, text, scope)
  if (!ok) throw new Error(`no <${tag}> with text "${text}"`)
}

if (!values['no-shots']) {
  // proposed card, rich
  await openCard(IP); await shot('proposed'); await shot('proposed', 'bottom'); await closeSheet()
  // blocked + urgent
  await openCard(IB); await shot('blocked-urgent'); await shot('blocked-urgent', 'bottom'); await closeSheet()
  // in review with checks
  await openCard(IR); await shot('review'); await shot('review', 'bottom'); await closeSheet()
  // done with timing (reopened)
  await openCard(ID); await shot('done'); await shot('done', 'mid'); await shot('done', 'bottom'); await closeSheet()
  // legacy: no v2 fields
  await openCard(IL); await shot('legacy'); await closeSheet()
  // edit mode
  await openCard(IP)
  await clickSel('[data-section="problem"] [role="button"]')
  await sleep(250)
  await shot('edit')
  await page.keyboard.press('Escape'); await sleep(150)
  await closeSheet()
}

const proof: Record<string, unknown> = {}
if (!values['no-proof']) {
  await openCard(PROOF_CARD)
  await expectPatch('urgent toggle', async () => { await clickSel('[data-toggle="urgent"]') }, proof)
  await expectPatch('later toggle', async () => { await clickSel('[data-toggle="later"]') }, proof)
  await expectPatch('blocked on…', async () => {
    await clickSel('[data-toggle="blocked"]')
    await page.waitForSelector('[data-blocked-input] input')
    await page.type('[data-blocked-input] input', 'IT: sandbox access')
    await page.keyboard.press('Enter')
  }, proof)
  await shot('blocked-edit')
  await expectPatch('unblock', async () => { await clickByText('button', 'Unblock') }, proof)
  await expectPatch('return medium', async () => { await clickSel('[data-level-picker="return"] [data-level="medium"]') }, proof)
  await expectPatch('effort low', async () => { await clickSel('[data-level-picker="effort"] [data-level="low"]') }, proof)
  await expectPatch('effort clear', async () => { await clickSel('[data-level-picker="effort"] [data-level="low"]') }, proof)
  await expectPatch('estimate 90m', async () => {
    const input = await page.$('input[aria-label="Estimate"]')
    await input!.click({ count: 3 }); await page.keyboard.type('90m'); await page.keyboard.press('Enter')
  }, proof)
  await expectPatch('estimate junk (no patch)', async () => {
    const input = await page.$('input[aria-label="Estimate"]')
    await input!.click({ count: 3 }); await page.keyboard.type('soon'); await page.keyboard.press('Enter')
  }, proof)
  await shot('estimate-error')
  await page.keyboard.press('Escape'); await sleep(200)
  await expectPatch('estimate clear', async () => {
    const input = await page.$('input[aria-label="Estimate"]')
    await input!.click({ count: 3 }); await page.keyboard.press('Backspace'); await page.keyboard.press('Enter')
  }, proof)
  await expectPatch('category pick/create', async () => {
    await clickSel('[data-field="category"]')
    await page.waitForSelector('input[aria-label="Search or create a category"]')
    await page.type('input[aria-label="Search or create a category"]', 'billing')
    await sleep(350)
    await shot('category-popover')
    await page.keyboard.press('Enter')
  }, proof)
  await expectPatch('tag add', async () => {
    await clickSel('input[aria-label="Add a tag"]')
    await page.keyboard.type('Quick, Perf')
    await page.keyboard.press('Enter')
  }, proof)
  await expectPatch('tag remove', async () => { await clickSel('[aria-label="Remove tag quick"]') }, proof)
  await expectPatch('assignee', async () => {
    await clickSel('[data-field="assignee"]')
    await page.waitForSelector('[role="option"]')
    await sleep(350)
    await shot('assignee-open')
    await page.evaluate(() => { const o = [...document.querySelectorAll('[role="option"]')].filter((e) => e.textContent?.includes('@')); ((o.find((e) => e.textContent?.includes('@james')) ?? o[0]) as HTMLElement)?.click() })
  }, proof)
  await expectPatch('title', async () => {
    await clickSel('[aria-label="Edit title"]')
    await page.keyboard.down('Meta'); await page.keyboard.press('a'); await page.keyboard.up('Meta')
    await page.keyboard.type('Sharper title for the ticket'); await page.keyboard.press('Enter')
  }, proof)
  await expectPatch('context via Cmd+Enter', async () => {
    await clickSel('[data-section="context"] [role="button"], [data-section="context"] button[data-empty]')
    await page.keyboard.type(' Added from the proof run.')
    await page.keyboard.down('Meta'); await page.keyboard.press('Enter'); await page.keyboard.up('Meta')
  }, proof)
  await expectPatch('approach: Esc cancels (no patch)', async () => {
    await clickSel('[data-section="approach"] [role="button"], [data-section="approach"] button[data-empty]')
    await page.keyboard.type('never saved'); await page.keyboard.press('Escape')
  }, proof)
  await expectPatch('details via blur', async () => {
    await clickSel('[data-section="details"]')
    await page.keyboard.type('Legacy notes live here.')
    await page.click('[data-properties]')
  }, proof)
  await expectPatch('add check', async () => {
    await clickSel('input[aria-label="Add a check"]')
    await page.keyboard.type('A brand new check'); await page.keyboard.press('Enter')
  }, proof)
  await expectPatch('tick check 0', async () => { await clickSel('[data-check-index="0"] [role="checkbox"]') }, proof)
  await expectPatch('move check 0 down', async () => { await page.click('[data-check-index="0"]'); await page.evaluate(() => (document.querySelector('[data-check-index="0"] [aria-label="Move down"]') as HTMLElement).click()) }, proof)
  await expectPatch('remove check 0', async () => { await page.evaluate(() => (document.querySelector('[data-check-index="0"] [aria-label="Remove"]') as HTMLElement).click()) }, proof)
  await expectPatch('comment', async () => {
    await clickSel('textarea[aria-label="Add a comment"]')
    await page.keyboard.type('Looks right to me.')
    await page.keyboard.down('Meta'); await page.keyboard.press('Enter'); await page.keyboard.up('Meta')
  }, proof)
  await shot('after-edits', 'bottom')
  proof.foldedEvents = await page.evaluate(() => document.querySelector('[data-note="folded"]')?.textContent ?? null)
  await clickByText('button', 'Comments only'); await sleep(200)
  proof.commentsOnlyCounts = await page.evaluate(() => ({ events: document.querySelectorAll('[data-note="event"]').length, comments: document.querySelectorAll('[data-note="comment"]').length }))
  await clickByText('button', 'Comments only'); await sleep(200)
  await expectPatch('footer: Accept', async () => { await clickSel('[data-footer] [data-action="accept"]') }, proof)
  await expectPatch('state menu → In progress', async () => {
    await clickSel('[data-state-menu]')
    await page.waitForSelector('[data-state-item]')
    await clickSel('[data-state-item="in_progress"]')
  }, proof)
  await expectPatch('footer: Send to review', async () => { await clickSel('[data-footer] [data-action="review"]') }, proof)
  await expectPatch('footer: Approve', async () => { await clickSel('[data-footer] [data-action="approve"]') }, proof)
  await shot('after-approve')
  await expectPatch('footer: Reopen', async () => { await clickSel('[data-footer] [data-action="reopen"]') }, proof)
  // copy buttons
  await clickByText('button', 'Copy for agent'); await sleep(200)
  await page.evaluate(() => (document.querySelector('button[aria-label="Copy pick command"]') as HTMLElement).click()); await sleep(200)
  proof.copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.map((t) => t.slice(0, 140)))
  // Esc inside a field must not close the sheet; Esc outside closes it
  await clickSel('textarea[aria-label="Add a comment"]'); await page.keyboard.press('Escape'); await sleep(250)
  proof.sheetOpenAfterEscInField = !!(await page.$(sheet))
  await page.keyboard.press('Escape'); await sleep(350)
  proof.sheetOpenAfterEscOutside = !!(await page.$(sheet))
}
console.log(JSON.stringify({ consoleErrors, pageErrors, patches: patches.length, proof, last: lastPatch() }, null, 2))
await browser.close()
