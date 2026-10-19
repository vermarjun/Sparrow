#!/usr/bin/env bun
// Interaction checks of the captain page against the mock (--no-live) served through vite.
//   bun scripts/captain-page-e2e.ts --url http://localhost:5282
// Exits 1 when a check fails; prints one line per check.
import { parseArgs } from 'node:util'
import puppeteer, { type Page } from 'puppeteer-core'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' }, project: { type: 'string' } } })
const URL_ = values.url ?? 'http://localhost:5282'
const PROJECT = values.project ?? 'plutus'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'], headless: true })
const page: Page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('sparrow.theme', 'light') } catch { /* */ } })
const errors: string[] = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))
let failed = 0
const check = (name: string, ok: boolean, info = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`) }
const go = async (hash: string) => { await page.goto(`${URL_}/#/${hash}${hash.includes('?') ? '&' : '?'}p=${PROJECT}`, { waitUntil: 'networkidle2' }).catch(() => {}); await page.waitForSelector('[role=tablist], h1, p.font-medium', { timeout: 8000 }).catch(() => {}); await sleep(900) }
const text = (sel: string) => page.$eval(sel, (e) => e.textContent ?? '').catch(() => null)
const count = (sel: string) => page.$$eval(sel, (e) => e.length)
const hash = () => page.evaluate(() => location.hash)

// title: Esc cancels, Enter saves, empty clears to the fallback
await go('captain/ag_orion')
await page.click('[data-testid=title]'); await page.keyboard.type(' XYZ'); await page.keyboard.press('Escape'); await sleep(200)
check('title: Esc cancels', (await text('[data-testid=title]'))?.trim() === 'Rate limiting for login' && !(await page.$('[data-testid=title-input]')))
await page.click('[data-testid=title]'); await page.keyboard.press('End'); await page.keyboard.type(' v2'); await page.keyboard.press('Enter'); await sleep(500)
check('title: Enter saves', (await text('[data-testid=title]'))?.includes('Rate limiting for login v2') ?? false)
check('title: sidebar follows', (await page.evaluate(() => document.body.innerText)).includes('Rate limiting for login v2'))
await page.click('[data-testid=title]'); await page.keyboard.press('End'); for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace'); await page.keyboard.press('Tab'); await sleep(500)
check('title: blur saves', (await text('[data-testid=title]'))?.trim() === 'Rate limiting for login')

// tabs: keyboard 2 / 3 / 1 and URL
await page.keyboard.press('2'); await sleep(300)
check('tab 2 → team in URL', (await hash()).includes('tab=team'))
await page.keyboard.press('3'); await sleep(300)
check('tab 3 → cards in URL', (await hash()).includes('tab=cards'))
await page.keyboard.press('1'); await sleep(300)
check('tab 1 → activity (no tab param)', !(await hash()).includes('tab='))

// team → sheet via click, Esc closes
await go('captain/ag_orion?tab=team')
const ROW = '[role=tabpanel] [data-row]'
check('team: tree rows (captain + 4 hires)', (await count(ROW)) === 5, `${await count(ROW)} rows`)
const rootLine = await page.$eval(ROW, (e) => e.textContent ?? '')
check('team: captain row shows its own title, not a fleet message', rootLine.includes('Rate limiting for login') && !rootLine.includes('Verify PR'), rootLine)
await page.focus(ROW); await page.keyboard.press('j'); await sleep(100)
check('team: j moves focus to the next row', await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.agent === 'ravi'))
await page.click('[data-agent=zoe]'); await sleep(900)
check('team: click opens agent sheet', (await hash()).includes('agent=ag_zoe') && !!(await page.$('[data-testid=agent-sheet]')))
check('sheet: screen peek is live', (await text('[data-testid=screen-peek]'))?.includes('live') ?? false)
const peek = await page.$eval('[data-testid=screen]', (e) => ({ h: e.clientHeight, bottom: e.scrollHeight - e.scrollTop - e.clientHeight }))
check('sheet: screen peek is 320 px and scrolled to the end', peek.h === 320 && peek.bottom <= 2, JSON.stringify(peek))
await page.keyboard.press('Escape'); await sleep(500)
check('Esc closes sheet', !(await hash()).includes('agent=') && !(await page.$('[data-testid=agent-sheet]')))

// activity: filter chip, hide updates, last screen
await go('captain/ag_cap')
const all = await count('[data-kind]')
const upd = await count('[data-kind=update]')
await page.evaluate(() => { [...document.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent?.includes('@james'))?.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await sleep(300)
const filtered = await count('[data-kind]')
check('filter: @james chip narrows the feed', filtered > 0 && filtered < all, `${all} → ${filtered}`)
await page.evaluate(() => { [...document.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent?.includes('Everyone'))?.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await sleep(300)
await page.click('button[aria-label="Hide updates"]'); await sleep(300)
check('hide updates removes update lines', upd > 0 && (await count('[data-kind=update]')) === 0, `${upd} → 0`)
await page.click('button[aria-label="Hide updates"]'); await sleep(300)
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /Show last screen/.test(b.textContent ?? ''))?.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await sleep(300)
check('crash notice: last screen expands', !!(await page.$('[data-testid=last-screen]')))

// outcomes: one row per agent with a result; a click scrolls to + highlights the message
const outs = await page.$$eval('[data-outcome]', (e) => e.map((x) => x.getAttribute('data-outcome')))
check('outcomes: rows for agents with results, newest first', outs.length > 0 && outs.length <= 4, outs.join(','))
await page.evaluate(() => { document.querySelector<HTMLElement>('[data-feed], [data-testid=feed]')!.scrollTop = 0 }); await sleep(200)
await page.click('[data-outcome]'); await sleep(700)
const hl = await page.evaluate(() => { const el = document.querySelector('[data-seq].bg-accent'); const feed = document.querySelector('[data-testid=feed]')!.getBoundingClientRect(); const r = el?.getBoundingClientRect(); return el ? { kind: el.querySelector('[data-kind]')?.getAttribute('data-kind'), visible: r!.top >= feed.top && r!.bottom <= feed.bottom } : null })
check('outcomes: click highlights the result message in view', !!hl && hl.kind === 'result' && hl.visible, JSON.stringify(hl))

// cards → ticket sheet
await go('captain/ag_cap?tab=cards')
await page.click('[role=tabpanel] [data-row]'); await sleep(900)
check('cards: row opens the ticket sheet', await page.evaluate(() => !!document.querySelector('[role=dialog]')))
await page.keyboard.press('Escape'); await sleep(400)

// resume menu + rename error
await go('captain/ag_orion')
check('resume primary says Open in tmux when the window is open', (await text('[data-testid=resume-primary]'))?.includes('Open in tmux') ?? false)
await page.click('[data-testid=resume-menu]'); await sleep(300)
check('resume menu lists copy + rename + archive', await page.evaluate(() => ['Copy resume command', 'Copy session id', 'Copy folder', 'Rename', 'Archive'].every((t) => document.body.innerText.includes(t))))
await page.evaluate(() => { [...document.querySelectorAll('[role=menuitem]')].find((i) => /Rename/.test(i.textContent ?? ''))?.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await sleep(400)
const input = await page.$('input[aria-label=Handle]')
check('rename dialog opens', !!input)
if (input) {
  await input.evaluate((el) => (el as HTMLInputElement).select()); await page.keyboard.type('Bad Name!'); await page.keyboard.press('Enter'); await sleep(500)
  check('rename: server error shown inline', (await page.$('[role=alert]')) != null, (await text('[role=alert]')) ?? '')
}

// session rail: one-line resume, no cd prefix
await go('captain/ag_orion')
const rail = await page.evaluate(() => {
  const el = [...document.querySelectorAll('aside span[title]')].find((e) => /--resume/.test(e.getAttribute('title') ?? '')) as HTMLElement | undefined
  return el ? { text: el.textContent, h: el.getBoundingClientRect().height, full: el.title } : null
})
check('rail: resume is one line without the cd prefix; title holds the full command', !!rail && rail.h <= 24 && rail.text!.startsWith('claude --resume') && rail.full.startsWith('cd '), JSON.stringify(rail))

// unknown captain
await go('captain/nobody')
check('unknown captain: calm empty state', (await page.evaluate(() => document.body.innerText)).includes('No captain @nobody in plutus'))

// the one expected 400 is the rename the server rejects above
const unexpected = errors.filter((e) => !/status of 400/.test(e))
check('no console errors (besides the rejected rename)', unexpected.length === 0, unexpected.join(' | '))
await browser.close()
process.exit(failed ? 1 : 0)
