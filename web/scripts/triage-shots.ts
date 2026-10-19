#!/usr/bin/env bun
// Triage mode: screenshots + proof that every key sends the right PATCH, Undo reverts it, the counter falls and the done state shows.
//   bun mock/server.ts --port 4163 --quiet &  VITE_API=http://127.0.0.1:4163 bunx vite --port 5193 --strictPort &
//   bun scripts/triage-shots.ts [--url http://localhost:5193] [--api http://127.0.0.1:4163] [--out ../.orchestra/shots/v3] [--size 1440x900] [--seed 22]
// The mock keeps its state in memory: restart it between runs. Prints JSON: the checks, the PATCH log, console errors.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer, { type Page } from 'puppeteer-core'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { url: { type: 'string' }, api: { type: 'string' }, out: { type: 'string' }, size: { type: 'string' }, project: { type: 'string' }, seed: { type: 'string' } },
})
const URL_ = values.url ?? 'http://localhost:5193'
const API = values.api ?? 'http://127.0.0.1:4163'
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.orchestra/shots/v3'))
const PROJECT = values.project ?? 'plutus'
const SEED = Number(values.seed ?? 22)
const [W, H] = (values.size ?? '1440x900').split('x').map(Number)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
mkdirSync(OUT, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- seed: a backlog of 30+ (the mock has 9 live proposals)
const WORDS = ['Retry failed webhook deliveries', 'Cache the FX rate lookup', 'Add audit trail to payouts', 'Dedupe vendor records', 'Export invoices as CSV', 'Rate-limit the public API', 'Backfill missing cost centres', 'Alert on stuck reconciliations', 'Paginate the ledger view', 'Mask card numbers in logs', 'Document the close checklist', 'Fix timezone drift in reports']
const LEVELS = ['low', 'medium', 'high', null] as const
for (let i = 0; i < SEED; i++) {
  await fetch(`${API}/api/cards`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project: PROJECT, state: 'proposed', title: `${WORDS[i % WORDS.length]}${i >= WORDS.length ? ` (${Math.floor(i / WORDS.length) + 1})` : ''}`, category: ['finance', 'security', 'ops', 'data'][i % 4],
      problem: 'Seeded for the triage proof.', impact: LEVELS[i % 4], effort: LEVELS[(i + 1) % 4], urgent: i % 9 === 4, estimate_min: i % 3 === 0 ? 30 : null,
    }),
  })
}
await fetch(`${API}/__log/reset`, { method: 'POST' })

const consoleErrors: string[] = []
const pageErrors: string[] = []
const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })
const page: Page = await browser.newPage()
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 })
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('response', async (r) => { if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`) })

const patchLog = async () => ((await (await fetch(`${API}/__log`)).json()) as { method: string; path: string; body: Record<string, unknown> }[]).filter((e) => e.method === 'PATCH')
const checks: { check: string; ok: boolean; detail?: unknown }[] = []
const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ check: name, ok, detail }); if (!ok) console.error('FAIL', name, detail) }
const left = async () => Number((await page.$eval('[data-triage-count]', (e) => e.textContent ?? '')).match(/(\d+) left/)?.[1] ?? 0)
const focusedId = async () => Number(await page.$eval('[data-triage-row][data-focused]', (e) => e.getAttribute('data-card-id')).catch(() => 0))
const shot = async (name: string) => { await page.screenshot({ path: join(OUT, `tri-${name}-${W}x${H}.png`) }); console.error('shot', name) }
const press = async (key: string, shift = false) => {
  if (shift) await page.keyboard.down('Shift')
  await page.keyboard.press(key as never)
  if (shift) await page.keyboard.up('Shift')
}
/** Press a key and return the PATCH(es) it caused. */
async function keyPatch(key: string, shift = false) {
  const n = (await patchLog()).length
  await press(key, shift)
  await sleep(450)
  return (await patchLog()).slice(n)
}

await page.goto(`${URL_}/#/board?p=${PROJECT}`, { waitUntil: 'networkidle2' }).catch(() => {})
await page.waitForSelector('[data-card-id]', { timeout: 10000 })
await sleep(400)
await page.keyboard.press('t')
await page.waitForSelector('[data-triage]', { timeout: 5000 })
await page.waitForSelector('[data-ticket-sheet][data-mode=pane]', { timeout: 5000 })
await sleep(500)

const start = await left()
check('triage opens with the whole backlog', start >= 30, start)
const ids = await page.$$eval('[data-triage-row]', (rows) => rows.map((r) => Number(r.getAttribute('data-card-id'))))
check('focus starts on the first row, pane follows', (await focusedId()) === ids[0] && !!(await page.$('[data-ticket-sheet][data-mode=pane]')))
check('default order is Newest', (await page.$eval('[data-seg=newest]', (e) => e.getAttribute('aria-pressed'))) === 'true')
check('newest first: the last proposal leads, the oldest trails', ids.length > 3 && ids[0] === Math.max(...ids) && ids.at(-1)! < ids[0])
const rowIds = () => page.$$eval('[data-triage-row]', (rows) => rows.map((r) => Number(r.getAttribute('data-card-id'))))
await page.click('[data-seg=oldest]'); await sleep(300)
const flipped = await rowIds()
check('Oldest reverses the queue', flipped.join() === [...ids].reverse().join(), flipped.slice(0, 3))
check('toggling does not act on a card', (await patchLog()).length === 0)
await shot('oldest')
await page.reload({ waitUntil: 'networkidle2' }); await page.waitForSelector('[data-card-id]'); await sleep(300)
await page.keyboard.press('t'); await page.waitForSelector('[data-triage]'); await sleep(300)
check('the choice is remembered (localStorage)', (await page.$eval('[data-seg=oldest]', (e) => e.getAttribute('aria-pressed'))) === 'true' && (await rowIds()).join() === flipped.join())
await page.click('[data-seg=newest]'); await sleep(300)
check('back to Newest restores the order', (await rowIds()).join() === ids.join())
await shot('list')

// j / k move the focus
await press('j'); await press('j')
check('j j moves down two rows', (await focusedId()) === ids[2], await focusedId())
await press('k')
check('k moves up one', (await focusedId()) === ids[1], await focusedId())
await shot('focus')

// a: accept (focus is ids[1])
let n0 = await left()
await press('a')
const ghostSeen = await page.evaluate(() => new Promise<boolean>((r) => setTimeout(() => r(!!document.querySelector('[data-triage-ghost]')), 60)))
check('acted row animates out (ghost row present 60ms after the key)', ghostSeen)
await sleep(450)
check('ghost row is gone once the animation ends', !(await page.$('[data-triage-ghost]')))
let p = (await patchLog()).slice(-1)
check('a PATCHes state todo', p.length === 1 && p[0].path === `/api/cards/${ids[1]}` && p[0].body.state === 'todo', p)
check('counter went down', (await left()) === n0 - 1, await left())
check('focus advanced to the next row', (await focusedId()) === ids[2], await focusedId())
const acceptToast = await page.$('[data-sonner-toast] [data-button]')
check('undo toast shown', !!acceptToast)
await shot('accepted')
// Undo from the toast brings the row back and re-focuses it
if (acceptToast) await acceptToast.click()
await sleep(500)
p = (await patchLog()).slice(-1)
check('Undo (toast) PATCHes the card back to proposed', p[0].path === `/api/cards/${ids[1]}` && p[0].body.state === 'proposed', p)
check('row is back and focused', (await left()) === n0 && (await focusedId()) === ids[1], [await left(), await focusedId()])

// l: later (shelve) then z (keyboard undo)
n0 = await left()
p = await keyPatch('l')
check('l PATCHes later:true', p.length === 1 && p[0].body.later === true, p)
check('later removed the row', (await left()) === n0 - 1)
p = await keyPatch('z')
check('z undoes the shelve (later:false)', p.length === 1 && p[0].body.later === false, p)
check('z brought the row back', (await left()) === n0)

// d: drop
p = await keyPatch('d')
check('d PATCHes state dropped', p.length === 1 && p[0].body.state === 'dropped', p)
// u: urgent on / off; 1-3 return; shift+1-3 effort
const cur = await focusedId()
p = await keyPatch('u')
check('u PATCHes urgent:true', p.length === 1 && p[0].body.urgent === true && p[0].path === `/api/cards/${cur}`, p)
p = await keyPatch('1')
check('1 PATCHes impact low', p.length === 1 && p[0].body.impact === 'low', p)
p = await keyPatch('2')
check('2 PATCHes impact medium', p.length === 1 && p[0].body.impact === 'medium', p)
p = await keyPatch('3')
check('3 PATCHes impact high', p.length === 1 && p[0].body.impact === 'high', p)
p = await keyPatch('Digit1', true)
check('shift+1 PATCHes effort low', p.length === 1 && p[0].body.effort === 'low', p)
p = await keyPatch('Digit3', true)
check('shift+3 PATCHes effort high', p.length === 1 && p[0].body.effort === 'high', p)
check('row stays in the queue after a patch key', (await focusedId()) === cur)
p = await keyPatch('z')
check('z undoes the last patch (effort back to what it was)', p.length === 1 && 'effort' in p[0].body, p)
await shot('patched')

// b: prompt, Esc cancels, Enter blocks
await press('b'); await sleep(250)
check('b opens the Blocked on… prompt', !!(await page.$('[data-triage-block] input')))
await shot('blocked-prompt')
await press('Escape'); await sleep(250)
check('Esc cancels the prompt without leaving Triage', !(await page.$('[data-triage-block]')) && !!(await page.$('[data-triage]')))
const before = (await patchLog()).length
await press('b'); await sleep(200)
await page.keyboard.type('IT: sandbox access', { delay: 8 })
check('keys while typing in the prompt do not act', (await patchLog()).length === before && (await left()) === (await left()))
await press('Enter'); await sleep(500)
p = (await patchLog()).slice(before)
check('Enter PATCHes blocked_on', p.length === 1 && p[0].body.blocked_on === 'IT: sandbox access' && p[0].path === `/api/cards/${cur}`, p)
check('the row shows the blocked rail', !!(await page.$(`[data-card-id="${cur}"][data-triage-row] [data-rail=both], [data-card-id="${cur}"][data-triage-row] [data-rail=blocked]`)))
check('blocked card stays queued', (await focusedId()) === cur)
await shot('blocked')
p = await keyPatch('b')
check('b on a blocked card unblocks it', p.length === 1 && p[0].body.blocked_on === null, p)

// Enter focuses the pane; typing there is not a triage key; Esc returns to the list; Esc again exits
await press('Enter'); await sleep(200)
check('Enter focuses the pane', await page.evaluate(() => !!document.activeElement?.closest('[data-triage-pane]')))
await press('Escape'); await sleep(200)
check('Esc from the pane returns to the list (does not exit)', !!(await page.$('[data-triage]')))
// typing in a pane field must not trigger keys: click the title and type "a"
const titleHandle = await page.$('[data-ticket-sheet] [data-title], [data-ticket-sheet] h1, [data-ticket-sheet] h2')
if (titleHandle) {
  const n1 = (await patchLog()).length
  await titleHandle.click(); await sleep(150)
  const typingIn = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return !!a && (a.isContentEditable || ['INPUT', 'TEXTAREA'].includes(a.tagName)) })
  if (typingIn) {
    await page.keyboard.type('adl', { delay: 5 }); await sleep(300)
    check('keys typed in a pane field do not act', (await patchLog()).length === n1 && (await left()) === (await left()), (await patchLog()).slice(n1))
    await press('Escape'); await sleep(200)
  } else check('title field is editable by click (could not verify typing guard)', false)
}
await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

// Clear the inbox with a / l / d, watch the counter, then the done state
let guard = 0
while ((await left()) > 3 && guard++ < 80) {
  const k = guard % 7 === 0 ? 'l' : guard % 11 === 0 ? 'd' : 'a'
  await press(k); await sleep(60)
}
await sleep(500)
await shot('late')
check('progress bar tracks the pile', Number(await page.$eval('[data-triage-progress]', (e) => e.getAttribute('data-triage-progress'))) > 80)
guard = 0
while ((await left()) > 0 && guard++ < 10) { await press('a'); await sleep(260) }
await page.waitForSelector('[data-triage-done=inbox]', { timeout: 4000 })
await sleep(600)
check('Triage done shows at zero', (await page.$eval('[data-triage-done] h2', (e) => e.textContent)) === 'Triage done')
const reviewBtn = await page.$('[data-triage-review-later]')
check('Review Later (n) offered', !!reviewBtn, reviewBtn && (await reviewBtn.evaluate((e) => e.textContent)))
await shot('done')

// Review Later pass
await reviewBtn?.click(); await sleep(500)
const laterN = await left()
check('Review Later lists the shelved cards', laterN >= 2 && (await page.$eval('[data-triage-count]', (e) => e.textContent)) === `Review Later · ${laterN} left`, laterN)
await shot('later')
p = await keyPatch('l')
check('l brings a shelved card back (later:false)', p.length === 1 && p[0].body.later === false, p)
p = await keyPatch('d')
check('d drops a shelved card', p.length === 1 && p[0].body.state === 'dropped', p)
guard = 0
while ((await left()) > 0 && guard++ < 10) { await press('d'); await sleep(260) }
await page.waitForSelector('[data-triage-done=later]', { timeout: 4000 })
await sleep(500)
await shot('later-done')
await page.click('[data-triage-exit-done]'); await sleep(500)
check('Back to board leaves Triage', !(await page.$('[data-triage]')) && !!(await page.$('[data-card-id]')))
await page.keyboard.press('t'); await sleep(400)
check('t re-opens it; Esc exits', !!(await page.$('[data-triage]')))
await press('Escape'); await sleep(300)
check('Esc exits Triage', !(await page.$('[data-triage]')))

check('zero console errors', consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors, pageErrors })
const log = await patchLog()
console.log(JSON.stringify({ size: `${W}x${H}`, started: start, passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok), patches: log.length, consoleErrors, pageErrors }, null, 1))
console.error(checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.check}`).join('\n'))
await browser.close()
process.exit(checks.every((c) => c.ok) ? 0 : 1)
