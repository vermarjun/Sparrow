#!/usr/bin/env bun
// Ticket sheet + quick-create screenshots, and proof that every edit path sends the right request. Run against a dev server pointed at the mock:
//   bun mock/server.ts --port 4162 --no-live --quiet &  VITE_API=http://127.0.0.1:4162 bunx vite --port 5192 --strictPort &
//   bun scripts/sheet-shots.ts [--url http://localhost:5192] [--out ../.orchestra/shots/v3] [--size 1440x900] [--no-proof] [--no-shots]
// Prints JSON: console errors, page errors, the PATCH / POST bodies each edit produced, and a few DOM facts.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer from 'puppeteer-core'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { url: { type: 'string' }, out: { type: 'string' }, size: { type: 'string' }, project: { type: 'string' }, 'no-proof': { type: 'boolean' }, ids: { type: 'string' }, card: { type: 'string' }, prefix: { type: 'string' }, 'no-shots': { type: 'boolean' } },
})
const URL_ = values.url ?? 'http://localhost:5192'
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.orchestra/shots/v3'))
const PROJECT = values.project ?? 'plutus'
// ids: proposed,blocked,review,done,legacy (mock defaults); card: the one the edit proof mutates; prefix: shot file prefix
const [IP, IB, IR, ID, IL] = (values.ids ?? '18,21,4,27,14').split(',').map(Number)
const PROOF_CARD = Number(values.card ?? IP)
const PREFIX = values.prefix ?? 'shee-'
const [W, H] = (values.size ?? '1440x900').split('x').map(Number)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const proof: Record<string, unknown> = {}
const consoleErrors: string[] = []
const pageErrors: string[] = []
const requests: { method: string; url: string; body: unknown }[] = []
const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })
const page = await browser.newPage()
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 })
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('response', async (r) => {
  if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()} ${(await r.text().catch(() => '')).slice(0, 200)}`)
})
page.on('request', (r) => {
  if (r.method() === 'PATCH' || r.method() === 'POST') requests.push({ method: r.method(), url: r.url().replace(/^https?:\/\/[^/]+/, ''), body: JSON.parse(r.postData() ?? 'null') })
})
await page.evaluateOnNewDocument(() => {
  // Clipboard in headless: record what was copied.
  ;(window as unknown as { __copied: string[] }).__copied = []
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t: string) => { (window as unknown as { __copied: string[] }).__copied.push(t); return Promise.resolve() } } })
})

const sheet = '[data-ticket-sheet]'
async function loadBoard() {
  await page.goto(`${URL_}/#/board?p=${PROJECT}`, { waitUntil: 'networkidle2' }).catch(() => {})
  await page.waitForSelector('[data-card-id]', { timeout: 10000 }).catch(async (e) => {
    console.error('board did not render; page text:', (await page.evaluate(() => document.body.innerText)).slice(0, 300), '\nconsole:', consoleErrors, pageErrors)
    throw e
  })
}
async function openCard(id: number) {
  await loadBoard()
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
  const file = `${PREFIX}${name}${scroll ? '-' + scroll : ''}-${W}x${H}.png`
  await page.screenshot({ path: join(OUT, file) })
  console.error('shot', file)
}
const lastRequest = () => requests.at(-1)
async function expectRequest(label: string, act: () => Promise<void>, results: Record<string, unknown>) {
  const n = requests.length
  await act()
  await sleep(450)
  results[label] = requests.slice(n).map((p) => (p.method === 'PATCH' ? p.body : { [p.method]: p.url, body: p.body }))
}
const clickSel = async (sel: string) => {
  try { await page.waitForSelector(sel, { timeout: 4000 }) } catch (e) {
    console.error(`FAILED waiting for ${sel}; sheet open: ${await page.evaluate(() => !!document.querySelector('[data-ticket-sheet]'))}; proof so far:`, JSON.stringify(proof, null, 1), consoleErrors, pageErrors)
    await page.screenshot({ path: join(OUT, `${PREFIX}failure.png`) })
    throw e
  }
  await page.click(sel)
}
const clickByText = async (tag: string, text: string, scope = sheet) => {
  const ok = await page.evaluate((t, x, sc) => {
    const root = document.querySelector(sc) ?? document
    const el = [...root.querySelectorAll(t)].find((e) => e.textContent?.trim() === x) as HTMLElement | undefined
    el?.click()
    return !!el
  }, tag, text, scope)
  if (!ok) throw new Error(`no <${tag}> with text "${text}"`)
}
const openProp = async (name: string) => {
  await clickSel(`[data-prop="${name}"]`)
  await page.waitForSelector(`[data-popover="${name}"]`)
  await sleep(220)
}
const openMenu = async (item: string) => {
  await clickSel('[data-more-menu]')
  await page.waitForSelector(`[data-menu="${item}"]`)
  await sleep(180)
}
const cmdEnter = async () => { await page.keyboard.down('Meta'); await page.keyboard.press('Enter'); await page.keyboard.up('Meta') }
const exists = (sel: string) => page.evaluate((s) => !!document.querySelector(s), sel)

if (!values['no-shots']) {
  // proposed card, rich
  await openCard(IP); await shot('proposed'); await shot('proposed', 'bottom'); await closeSheet()
  // blocked + urgent
  await openCard(IB); await shot('blocked-urgent'); await shot('blocked-urgent', 'bottom'); await closeSheet()
  // in review with checks
  await openCard(IR); await shot('review'); await shot('review', 'bottom'); await closeSheet()
  // done with timing: collapsed line, then expanded
  await openCard(ID); await shot('done')
  await clickSel('[data-section="timing"] button'); await sleep(250)
  await shot('done-timing', 'mid'); await shot('done-timing', 'bottom'); await closeSheet()
  // legacy: no v2 fields
  await openCard(IL); await shot('legacy'); await closeSheet()
  // popovers and menus
  await openCard(IP)
  await openProp('return'); await shot('pop-return'); await page.keyboard.press('Escape'); await sleep(200)
  await openProp('category'); await shot('pop-category'); await page.keyboard.press('Escape'); await sleep(200)
  await openProp('assignee'); await shot('pop-assignee'); await page.keyboard.press('Escape'); await sleep(200)
  await openMenu('urgent'); await shot('menu-more'); await page.keyboard.press('Escape'); await sleep(200)
  await clickSel('[data-copy-split] button[aria-label="More ways to copy"]'); await sleep(250); await shot('menu-copy'); await page.keyboard.press('Escape'); await sleep(200)
  await clickSel('[data-state-menu]'); await sleep(250); await shot('menu-state'); await page.keyboard.press('Escape'); await sleep(200)
  await clickSel('[data-add="details"]'); await sleep(250); await shot('edit-section', 'bottom')
  await page.keyboard.press('Escape'); await sleep(150)
  await closeSheet()
  // pane mode: Triage mode hosts the sheet inline
  await loadBoard()
  await page.keyboard.press('t'); await sleep(700)
  if (await exists('[data-mode="pane"]')) { await shot('pane'); await page.keyboard.press('Escape'); await sleep(300) } else console.error('Triage pane not available on this build; skipped pane shot')
  // quick create: collapsed (empty), collapsed with chips, expanded
  await loadBoard()
  await clickSel('[data-testid="new-ticket"]')
  await page.waitForSelector('[data-testid="new-ticket-dialog"]'); await sleep(300)
  await shot('create-empty')
  await page.type('#new-ticket-title', 'Add a quarterly export preset')
  await clickSel('[data-chip="category"]'); await page.waitForSelector('[data-popover="category"]'); await sleep(200)
  await page.type('input[aria-label="Search or create a category"]', 'export'); await sleep(200); await page.keyboard.press('Enter'); await sleep(200)
  await clickSel('[data-chip="return"]'); await page.waitForSelector('[data-popover="return"]'); await sleep(200); await clickSel('[data-popover="return"] [data-level="high"]'); await sleep(200)
  await clickSel('[data-chip="effort"]'); await page.waitForSelector('[data-popover="effort"]'); await sleep(200); await clickSel('[data-popover="effort"] [data-level="low"]'); await sleep(200)
  await clickSel('[data-chip="estimate"]'); await page.waitForSelector('[data-popover="estimate"]'); await sleep(200); await page.keyboard.type('90m'); await page.keyboard.press('Enter'); await sleep(200)
  await shot('create-chips')
  await clickSel('[data-add-details]'); await sleep(250)
  await page.type('[data-brief="context"]', 'Asked by finance during the quarterly planning review.')
  await page.type('[data-brief="problem"]', 'Observed: the export range is re-entered each quarter. Expected: reuse a saved preset.')
  await shot('create-details')
  await page.keyboard.press('Escape'); await sleep(200)
  await page.keyboard.press('Escape'); await sleep(300)
}

if (!values['no-proof']) {
  // quick create: Enter in the title creates; the body carries the chips
  await loadBoard()
  await clickSel('[data-testid="new-ticket"]')
  await page.waitForSelector('#new-ticket-title'); await sleep(300)
  await expectRequest('create: title only, Enter', async () => {
    await page.type('#new-ticket-title', 'Quick ticket from the proof run'); await page.keyboard.press('Enter')
    await page.waitForFunction(() => !document.querySelector('[data-testid="new-ticket-dialog"]'), { timeout: 5000 })
  }, proof)
  await clickSel('[data-testid="new-ticket"]')
  await page.waitForSelector('#new-ticket-title'); await sleep(300)
  await expectRequest('create: chips + details, Cmd+Enter', async () => {
    await page.type('#new-ticket-title', 'Ticket with chips and a brief')
    await clickSel('[data-chip="state"]'); await page.waitForSelector('[data-popover="state"]'); await sleep(200); await clickSel('[data-state-option="proposed"]'); await sleep(150)
    await clickSel('[data-chip="urgent"]')
    await clickSel('[data-chip="return"]'); await page.waitForSelector('[data-popover="return"]'); await sleep(200); await clickSel('[data-popover="return"] [data-level="medium"]'); await sleep(150)
    await clickSel('[data-chip="estimate"]'); await page.waitForSelector('[data-popover="estimate"]'); await sleep(200); await page.keyboard.type('2h'); await page.keyboard.press('Enter'); await sleep(150)
    await clickSel('[data-add-details]'); await sleep(200)
    await page.type('[data-brief="problem"]', 'Something is wrong.')
    await page.type('[data-brief="done-when"]', '- first check\n- second check')
    await cmdEnter()
    await page.waitForFunction(() => !document.querySelector('[data-testid="new-ticket-dialog"]'), { timeout: 5000 })
  }, proof)

  await openCard(PROOF_CARD)
  proof.sheetFacts = await page.evaluate(() => ({
    sheetIsOverlay: !!document.querySelector('[data-ticket-sheet][role="dialog"]'),
    toggleGridGone: !document.querySelector('[data-toggle]'),
    flagBadgesGone: !document.querySelector('[data-flag]'),
    sentence: (document.querySelector('[data-properties]') as HTMLElement | null)?.innerText.replace(/\s+/g, ' '),
    emptyLine: (document.querySelector('[data-empty-line]') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ') ?? null,
    blockedWords: [...document.querySelectorAll('[data-ticket-sheet] *')].filter((e) => e.children.length === 0 && /blocked/i.test(e.textContent ?? '')).length,
  }))
  await expectRequest('urgent via ⋯ menu', async () => { await openMenu('urgent'); await clickSel('[data-menu="urgent"]') }, proof)
  await shot('urgent-set')
  await expectRequest('urgent word click clears', async () => { await clickSel('[data-prop="urgent"]') }, proof)
  await expectRequest('later via ⋯ menu', async () => { await openMenu('later'); await clickSel('[data-menu="later"]') }, proof)
  await expectRequest('bring back via ⋯ menu', async () => { await openMenu('later'); await clickSel('[data-menu="later"]') }, proof)
  await expectRequest('blocked on… via ⋯ menu', async () => {
    await openMenu('blocked'); await clickSel('[data-menu="blocked"]')
    await page.waitForSelector('[data-blocked-input] input'); await sleep(250)
    proof.blockedInputFocused = await page.evaluate(() => document.activeElement === document.querySelector('[data-blocked-input] input'))
    await shot('blocked-asking')
    await page.type('[data-blocked-input] input', 'IT: sandbox access')
    await page.keyboard.press('Enter')
  }, proof)
  await shot('blocked-set')
  proof.footerWhileBlocked = await page.evaluate(() => [...document.querySelectorAll('[data-footer] [data-action]')].map((b) => (b as HTMLElement).dataset.action))
  await expectRequest('unblock (banner)', async () => { await clickByText('button', 'Unblock') }, proof)
  await expectRequest('blocked again, then footer Unblock', async () => {
    await openMenu('blocked'); await clickSel('[data-menu="blocked"]')
    await page.waitForSelector('[data-blocked-input] input'); await page.type('[data-blocked-input] input', 'Waiting on design'); await page.keyboard.press('Enter'); await sleep(300)
    await clickSel('[data-footer] [data-action="unblock"]')
  }, proof)
  await expectRequest('blocked then ⋯ Unblock', async () => {
    await openMenu('blocked'); await clickSel('[data-menu="blocked"]')
    await page.waitForSelector('[data-blocked-input] input'); await page.type('[data-blocked-input] input', 'x'); await page.keyboard.press('Enter'); await sleep(300)
    await openMenu('blocked'); await clickSel('[data-menu="blocked"]')
  }, proof)
  await expectRequest('blocked asking, Esc (no patch)', async () => {
    await openMenu('blocked'); await clickSel('[data-menu="blocked"]')
    await page.waitForSelector('[data-blocked-input] input'); await sleep(200); await page.keyboard.press('Escape')
  }, proof)
  proof.sheetStillOpenAfterEscInBlockInput = await exists(sheet)
  await expectRequest('return medium', async () => { await openProp('return'); await clickSel('[data-popover="return"] [data-level="medium"]') }, proof)
  await expectRequest('effort low', async () => { await openProp('effort'); await clickSel('[data-popover="effort"] [data-level="low"]') }, proof)
  await shot('payoff-set')
  await expectRequest('effort cleared', async () => { await openProp('effort'); await clickSel('[data-popover="effort"] [data-clear]') }, proof)
  await expectRequest('estimate 90m', async () => {
    await openProp('estimate'); await page.keyboard.type('90m'); await page.keyboard.press('Enter')
  }, proof)
  await expectRequest('estimate junk (no patch)', async () => {
    await openProp('estimate'); await page.keyboard.type('soon'); await page.keyboard.press('Enter')
  }, proof)
  await shot('estimate-error')
  await page.keyboard.press('Escape'); await sleep(200)
  await expectRequest('estimate clear', async () => {
    await openProp('estimate'); await page.keyboard.press('Backspace'); await page.keyboard.press('Enter')
  }, proof)
  await expectRequest('category create', async () => {
    await openProp('category')
    await page.type('input[aria-label="Search or create a category"]', 'billing')
    await sleep(300)
    await page.keyboard.press('Enter')
  }, proof)
  await expectRequest('tag add', async () => {
    await openProp('tags')
    await page.keyboard.type('Quick, Perf')
    await page.keyboard.press('Enter')
  }, proof)
  await shot('tags-open')
  await expectRequest('tag remove', async () => { await clickSel('[aria-label="Remove tag quick"]') }, proof)
  await page.keyboard.press('Escape'); await sleep(200)
  await expectRequest('assignee @james', async () => { await openProp('assignee'); await clickSel('[data-assignee="james"]') }, proof)
  await expectRequest('assignee cleared', async () => { await openProp('assignee'); await clickSel('[data-assignee="none"]') }, proof)
  await expectRequest('title', async () => {
    await clickSel('[aria-label="Edit title"]')
    await page.keyboard.down('Meta'); await page.keyboard.press('a'); await page.keyboard.up('Meta')
    await page.keyboard.type('Sharper title for the ticket'); await page.keyboard.press('Enter')
  }, proof)
  await expectRequest('+ Context via Cmd+Enter', async () => {
    const had = await exists('[data-section="context"]')
    await clickSel(had ? '[data-section="context"] [role="button"]' : '[data-add="context"]')
    await page.keyboard.type(' Added from the proof run.')
    await cmdEnter()
  }, proof)
  await expectRequest('+ Approach, Esc cancels (no patch)', async () => {
    await clickSel('[data-add="approach"], [data-section="approach"] [role="button"]')
    await page.keyboard.type('never saved'); await page.keyboard.press('Escape')
  }, proof)
  await expectRequest('+ Details via blur', async () => {
    await clickSel('[data-add="details"], [data-section="details"] [role="button"]')
    await page.keyboard.type('Legacy notes live here.')
    await page.click('[data-properties]')
  }, proof)
  await expectRequest('+ Done when, add check', async () => {
    const had = await exists('[data-section="checks"]')
    if (!had) await clickSel('[data-add="checks"]')
    await clickSel('input[aria-label="Add a check"]')
    await page.keyboard.type('A brand new check'); await page.keyboard.press('Enter')
  }, proof)
  await expectRequest('tick check 0', async () => { await clickSel('[data-check-index="0"] [role="checkbox"]') }, proof)
  await expectRequest('move check 0 down', async () => { await page.click('[data-check-index="0"]'); await page.evaluate(() => (document.querySelector('[data-check-index="0"] [aria-label="Move down"]') as HTMLElement | null)?.click()) }, proof)
  await expectRequest('remove check 0', async () => { await page.evaluate(() => (document.querySelector('[data-check-index="0"] [aria-label="Remove"]') as HTMLElement).click()) }, proof)
  await expectRequest('comment', async () => {
    await clickSel('textarea[aria-label="Add a comment"]')
    await page.keyboard.type('Looks right to me.')
    await cmdEnter()
  }, proof)
  await shot('after-edits', 'bottom')
  await clickByText('button', 'Comments only'); await sleep(200)
  proof.commentsOnlyCounts = await page.evaluate(() => ({ events: document.querySelectorAll('[data-note="event"]').length, comments: document.querySelectorAll('[data-note="comment"]').length }))
  await clickByText('button', 'Comments only'); await sleep(200)
  await expectRequest('footer: Accept', async () => { await clickSel('[data-footer] [data-action="accept"]') }, proof)
  await expectRequest('state menu → In progress', async () => {
    await clickSel('[data-state-menu]')
    await page.waitForSelector('[data-state-item]')
    await clickSel('[data-state-item="in_progress"]')
  }, proof)
  await expectRequest('footer: Send to review', async () => { await clickSel('[data-footer] [data-action="review"]') }, proof)
  await shot('review-after-moves')
  await expectRequest('footer: Approve', async () => { await clickSel('[data-footer] [data-action="approve"]') }, proof)
  proof.timingLineInDone = await page.evaluate(() => (document.querySelector('[data-timing-line]') as HTMLElement | null)?.innerText ?? null)
  await shot('after-approve')
  proof.movesFolded = await page.evaluate(() => [...document.querySelectorAll('[data-note="moves"] button')].map((b) => (b as HTMLElement).innerText))
  await expectRequest('footer: Reopen', async () => { await clickSel('[data-footer] [data-action="reopen"]') }, proof)
  await expectRequest('⋯ Drop', async () => { await openMenu('drop'); await clickSel('[data-menu="drop"]') }, proof)
  await expectRequest('footer: Restore', async () => { await clickSel('[data-footer] [data-action="restore"]') }, proof)
  // empty sections on a legacy ticket: "+ Approach" opens in place, Esc / blur-empty collapses it back, a typed one stays
  await closeSheet(); await openCard(IL)
  proof.legacyEmptyLine = await page.evaluate(() => (document.querySelector('[data-empty-line]') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ') ?? null)
  await expectRequest('legacy: + Approach, type, Esc (no patch)', async () => { await clickSel('[data-add="approach"]'); await page.keyboard.type('draft'); await page.keyboard.press('Escape') }, proof)
  proof.approachCollapsedAgain = !(await exists('[data-section="approach"]'))
  await expectRequest('legacy: + Approach, blur empty (no patch)', async () => { await clickSel('[data-add="approach"]'); await sleep(150); await page.click('[data-properties]') }, proof)
  proof.approachCollapsedAfterBlur = !(await exists('[data-section="approach"]'))
  await shot('legacy-add-open')
  await expectRequest('legacy: + Approach, Cmd+Enter', async () => { await clickSel('[data-add="approach"]'); await page.keyboard.type('Plain plan.'); await cmdEnter() }, proof)
  await expectRequest('legacy: + Done when, first check', async () => { await clickSel('[data-add="checks"]'); await sleep(150); await page.keyboard.type('It works'); await page.keyboard.press('Enter') }, proof)
  await shot('legacy-filled')
  await closeSheet(); await openCard(PROOF_CARD)
  // copy: the main button copies the brief, the chevron menu also offers the pick command
  await clickByText('button', 'Copy for agent'); await sleep(200)
  await clickSel('[data-copy-split] button[aria-label="More ways to copy"]'); await sleep(250)
  await page.evaluate(() => ([...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent?.includes('pick command')) as HTMLElement).click()); await sleep(250)
  proof.copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.map((t) => t.slice(0, 140)))
  // Esc inside a field must not close the sheet; Esc outside closes it
  await clickSel('textarea[aria-label="Add a comment"]'); await page.keyboard.press('Escape'); await sleep(250)
  proof.sheetOpenAfterEscInField = await exists(sheet)
  await page.keyboard.press('Escape'); await sleep(350)
  proof.sheetOpenAfterEscOutside = await exists(sheet)
}
console.log(JSON.stringify({ consoleErrors, pageErrors, requests: requests.length, proof, last: lastRequest() }, null, 2))
await browser.close()
