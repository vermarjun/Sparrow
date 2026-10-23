#!/usr/bin/env bun
import { chromeExecutable } from './browser'
// Shell screenshots + keyboard / overflow assertions against the mock (UI served by vite, API by the mock).
//   bun scripts/captains-shell-shots.ts [--url http://localhost:5281] [--api http://127.0.0.1:4181] [--out ../.sandbox/shots/captains] [--only home,cmdk] [--themes light,dark]
// Start the mock with --no-live for stable shots. Prints a JSON summary: checks, console errors, page errors.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer, { type Page } from 'puppeteer-core'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' }, api: { type: 'string' }, out: { type: 'string' }, only: { type: 'string' }, themes: { type: 'string' }, project: { type: 'string' } } })
const URL_ = values.url ?? process.env.SPARROW_WEB_URL ?? 'http://localhost:5281'
const API = values.api ?? process.env.SPARROW_MOCK_URL ?? 'http://127.0.0.1:4181'
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.sandbox/shots/captains'))
const PROJECT = values.project ?? process.env.SPARROW_DEMO_PROJECT ?? 'tortuga'
const ONLY = values.only ? new Set(values.only.split(',')) : null
const THEMES = (values.themes ?? 'light,dark').split(',') as ('light' | 'dark')[]
const CHROME = chromeExecutable()
mkdirSync(OUT, { recursive: true })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const consoleErrors: string[] = []
const pageErrors: string[] = []
let expected400 = 0 // the deliberate bad-name submit below makes the browser log one 400
const checks: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); console.error(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
const want = (name: string) => !ONLY || ONLY.has(name)

const captains: { agent: { id: string; handle: string }; status: string }[] = await fetch(`${API}/api/captains?project=${PROJECT}&archived=1`).then((r) => r.json())
const idOf = (handle: string) => captains.find((c) => c.agent.handle === handle)?.agent.id ?? ''


// The mock has no /api/skills: serve a small fixture so the Skills page can be shot (library + one conflict + a code-risk warning).
const link = (harness: string, state: string) => ({ harness, wanted: true, state, path: `~/.${harness}/skills/x`, alsoReadBy: [], viaRoot: null })
const skill = (name: string, description: string, extra: Record<string, unknown> = {}) => ({
  name, description, path: `~/.sparrow/skills/${name}`, locked: false, source: 'local', sourceUrl: null, inManifest: true, harnesses: ['claude', 'codex'],
  links: [link('claude', 'linked'), link('codex', 'linked'), link('opencode', 'off')], problems: [], ...extra,
})
const SKILLS = {
  library_missing: false, library_problem: null,
  library: [
    skill('sparrow-captain', 'Run a team of AI agents with Sparrow from your own session.', { source: 'sparrow', locked: true }),
    skill('dataviz', 'Charts that read as one system in light and dark.', { source: 'github', sourceUrl: 'https://github.com/acme/dataviz.git' }),
    skill('release-notes', 'Draft release notes from merged PRs.', { links: [link('claude', 'linked'), link('codex', 'conflict'), link('opencode', 'missing')], problems: [{ code: 'frontmatter', message: 'description is longer than 200 characters' }] }),
  ],
  unmanaged: [], external: [], conflicts: [], broken: [],
  git: { available: true, branch: 'main', dirty: ['release-notes/SKILL.md'], ahead: 1, behind: 0, remote: 'git@github.com:acme/skills.git' },
  paths: { library: '~/.sparrow/skills', home: '/home/demo', backup: '~/.sparrow/backups', roots: { library: '~/.sparrow/skills', claude: '~/.claude/skills', codex: '~/.codex/skills', opencode: '~/.config/opencode/skills', agents: '~/.agents/skills', 'claude-synced': '~/.claude/skills', sparrow: '~/.sparrow/skills' }, sandbox: false },
  warnings: [],
}

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })

async function session(theme: 'light' | 'dark', size: { width: number; height: number }, body: (page: Page, shot: (name: string) => Promise<void>) => Promise<void>) {
  const page = await browser.newPage()
  await page.setViewport({ ...size, deviceScaleFactor: 1, hasTouch: size.width < 600 })
  await page.evaluateOnNewDocument((t) => { try { localStorage.setItem('sparrow.theme', t); localStorage.removeItem('sparrow.sidebar') } catch { /* */ } }, theme)
  await page.setRequestInterception(true)
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/skills' && r.method() === 'GET') void r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(SKILLS) })
    else if (new URL(r.url()).pathname === '/api/skills/updates') void r.respond({ status: 200, contentType: 'application/json', body: '[]' })
    else void r.continue()
  })
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    if (expected400 > 0 && m.text().includes('400')) { expected400--; return }
    consoleErrors.push(`[${theme} ${size.width}] ${m.text()}`)
  })
  page.on('response', (r) => { if (r.status() >= 400 && !(expected400 > 0)) consoleErrors.push(`[${theme} ${size.width}] ${r.status()} ${r.url()}`) })
  page.on('pageerror', (e) => pageErrors.push(`[${theme} ${size.width}] ${String(e)}`))
  const shot = async (name: string) => { await page.screenshot({ path: join(OUT, `${name}-${theme}.png`) }); console.error(`shot ${name}-${theme}.png`) }
  try { await body(page, shot) } finally { await page.close() }
}
const go = async (page: Page, hash: string) => {
  await page.goto(`${URL_}/#/${hash}${hash.includes('?') ? '&' : '?'}p=${PROJECT}`, { waitUntil: 'networkidle2' }).catch(() => {})
  await page.waitForFunction(() => document.readyState === 'complete')
  await sleep(500)
}
const noOverflow = async (page: Page, name: string, max: number) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth)
  check(`no horizontal scroll: ${name}`, w <= max, `scrollWidth ${w}`)
}
const press = async (page: Page, key: string, mod?: 'Meta') => {
  if (mod) await page.keyboard.down(mod)
  await page.keyboard.press(key as never)
  if (mod) await page.keyboard.up(mod)
  await sleep(250)
}
const clickText = (page: Page, sel: string, text: string) =>
  page.evaluate((s, t) => { const b = [...document.querySelectorAll<HTMLElement>(s)].find((x) => x.textContent?.trim().startsWith(t)); b?.click(); return !!b }, sel, text)

for (const theme of THEMES) {
  // ---------------------------------------------------------------- desktop 1440x900
  await session(theme, { width: 1440, height: 900 }, async (page, shot) => {
    if (want('home')) { await go(page, 'captains'); await shot('home') }
    if (want('home-hover')) {
      await go(page, 'captains')
      const row = await page.$('[data-captain-row]:nth-of-type(3)')
      const box = await row!.boundingBox()
      await page.mouse.move(box!.x + 400, box!.y + box!.height / 2)
      await sleep(400)
      await shot('home-hover')
    }
    if (want('sidebar-archived-open')) {
      await go(page, `captain/${idOf('cap-orion')}`)
      await clickText(page, 'button', 'Archived')
      await sleep(300)
      await shot('sidebar-archived-open')
    }
    if (want('sidebar-collapsed')) {
      await go(page, `captain/${idOf('cap-orion')}`)
      await press(page, 'b', 'Meta')
      await sleep(300)
      await shot('sidebar-collapsed')
      await press(page, 'b', 'Meta')
      await sleep(300)
    }
    if (want('cmdk')) {
      await go(page, 'captains')
      await press(page, 'k', 'Meta')
      await shot('cmdk')
      await page.keyboard.type('rate')
      await sleep(300)
      await shot('cmdk-search')
      await press(page, 'Escape')
    }
    if (want('new-captain')) {
      await go(page, 'captains')
      await clickText(page, 'button', 'New captain')
      await sleep(500)
      await page.keyboard.type('Rate limiting for login')
      await shot('new-captain')
      await press(page, 'Escape')
    }
    if (want('board-captain-filter')) {
      await go(page, 'board')
      await page.waitForSelector('[data-card-id]', { timeout: 8000 }).catch(() => {})
      await page.click('[data-testid=filter]')
      await sleep(300)
      await page.click('[data-testid=filter-captain]').catch(() => {})
      await sleep(300)
      await shot('board-captain-filter-open')
      await page.evaluate(() => ([...document.querySelectorAll<HTMLElement>('[role=option]')].find((o) => o.textContent?.includes('CSV export')))?.click())
      await sleep(300)
      await page.keyboard.press('Escape')
      await sleep(400)
      await shot('board-captain-filter')
    }
    for (const p of ['board', 'resumes', 'skills', 'doctor', 'settings'] as const) {
      if (want(p)) { await go(page, p); await shot(p) }
    }
  })
  // ---------------------------------------------------------------- mobile 390x844
  await session(theme, { width: 390, height: 844 }, async (page, shot) => {
    if (want('mobile-home')) { await go(page, 'captains'); await noOverflow(page, 'mobile home', 390); await shot('mobile-home') }
    if (want('mobile-sidebar-open')) {
      await go(page, 'captains')
      await page.click('[aria-label="Open menu"]')
      await sleep(500)
      await noOverflow(page, 'mobile sidebar open', 390)
      await shot('mobile-sidebar-open')
    }
    if (want('mobile-pages')) {
      for (const p of ['board', 'resumes', 'skills', 'doctor', 'settings', `captain/${idOf('cap-orion')}`]) { await go(page, p); await noOverflow(page, `mobile ${p.split('/')[0]}`, 390) }
    }
  })
}

// ---------------------------------------------------------------- keyboard + interaction checks (light, desktop). Mutates the mock: run it last.
if (want('keys')) {
  await session('light', { width: 1440, height: 900 }, async (page) => {
    const open = () => page.evaluate(() => !!document.querySelector('[role=dialog] [cmdk-input]'))
    const active = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? '')
    const hash = () => page.evaluate(() => location.hash)
    const asideW = () => page.evaluate(() => Math.round(document.querySelector('aside')!.getBoundingClientRect().width))
    await go(page, 'captains')

    await press(page, 'k', 'Meta'); check('⌘K opens the palette', await open())
    await press(page, 'k', 'Meta'); check('⌘K closes it', !(await open()))
    await press(page, 'k', 'Meta'); await press(page, 'Escape'); check('Esc closes the palette', !(await open()))
    await press(page, 'k', 'Meta'); await page.keyboard.type('vega'); await sleep(200); await press(page, 'Enter')
    check('palette: type + Enter opens the captain', (await hash()).includes(`captain/${idOf('cap-vega')}`), await hash())
    await go(page, 'captains')

    const w0 = await asideW(); await press(page, 'b', 'Meta'); await sleep(300); const w1 = await asideW(); await press(page, 'b', 'Meta'); await sleep(300); const w2 = await asideW()
    check('⌘B collapses and restores the sidebar', w0 === 260 && w1 === 56 && w2 === 260, `${w0} → ${w1} → ${w2}`)

    await press(page, '/'); check('/ focuses the sidebar search', (await active()) === 'Search captains', await active())
    await page.keyboard.type('rate'); await sleep(250)
    const hits = await page.evaluate(() => document.querySelectorAll('nav[aria-label=Captains] [data-row]').length)
    check('sidebar search filters live', hits === 1, `${hits} rows for "rate"`)
    await press(page, 'Escape'); const cleared = await page.evaluate(() => (document.querySelector('input[aria-label="Search captains"]') as HTMLInputElement).value)
    check('Esc clears the search', cleared === '')
    await page.keyboard.press('ArrowDown'); await sleep(150)
    const firstFocused = await page.evaluate(() => document.activeElement?.hasAttribute('data-row') ?? false)
    await page.keyboard.press('j'); await sleep(150)
    const second = await page.evaluate(() => { const rows = [...document.querySelectorAll('nav[aria-label=Captains] [data-row]')]; return rows.indexOf(document.activeElement as Element) })
    check('sidebar: ↓ from search then j walks the rows', firstFocused && second === 1, `index ${second}`)
    await page.keyboard.press('k'); await page.keyboard.press('Enter'); await sleep(400)
    check('sidebar: Enter opens the focused captain', (await hash()).startsWith('#/captain/'), await hash())

    await go(page, 'captains')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await press(page, 'j'); await press(page, 'j')
    const focusedIdx = await page.evaluate(() => [...document.querySelectorAll('[data-captain-row]')].findIndex((r) => r.hasAttribute('data-focused')))
    check('home: j j focuses the second row', focusedIdx === 1, `index ${focusedIdx}`)
    await press(page, 'k'); await press(page, 'Enter')
    check('home: k then Enter opens the first captain', (await hash()).startsWith('#/captain/'), await hash())

    // project switcher keeps the page type
    await go(page, 'board')
    await page.click('[aria-label="Switch project"]'); await sleep(300)
    await page.evaluate(() => [...document.querySelectorAll('[cmdk-item]')].find((x) => x.textContent?.includes('sparrow'))?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await sleep(500)
    check('project switch keeps the Board page', (await hash()).startsWith('#/board') && (await hash()).includes('p=sparrow'), await hash())
    await go(page, 'captains')

    // New captain: inline errors, then success
    await clickText(page, 'button', 'New captain'); await sleep(400)
    await page.keyboard.press('Enter'); await sleep(200)
    check('New captain: empty title shows an inline error', await page.evaluate(() => !!document.querySelector('#nc-title-err')?.textContent))
    await page.keyboard.type('Retry storm in the exporter')
    await page.click('#nc-cwd'); await page.evaluate(() => (document.querySelector('#nc-cwd') as HTMLInputElement).select()); await page.keyboard.press('Backspace')
    await page.keyboard.press('Escape'); await sleep(150)
    check('New captain: Esc inside the folder list does not close the dialog', await page.evaluate(() => !!document.querySelector('[role=dialog] #nc-title')))
    await page.keyboard.press('Enter'); await sleep(200)
    check('New captain: empty folder shows an inline error', await page.evaluate(() => !!document.querySelector('#nc-cwd-err')?.textContent))
    await page.keyboard.type('~/code/tortuga'); await page.keyboard.press('Escape')
    await page.evaluate(() => (document.querySelector('#nc-name') as HTMLInputElement).focus()); await page.keyboard.type('Bad Name!')
    expected400++
    await page.keyboard.press('Enter'); await sleep(600)
    const nameErr = await page.evaluate(() => document.querySelector('#nc-name-err')?.textContent ?? '')
    check('New captain: a `name:` server error shows under Name', nameErr.length > 0, nameErr)
    for (let i = 0; i < 9; i++) await page.keyboard.press('Backspace')
    await page.keyboard.press('Enter'); await sleep(900)
    check('New captain: success navigates to the new captain', (await hash()).startsWith('#/captain/'), await hash())
    check('New captain: toast offers Copy tmux attach', await page.evaluate(() => document.body.textContent?.includes('Copy tmux attach') ?? false))
  })
}

await browser.close()
const failed = checks.filter((c) => !c.ok)
console.log(JSON.stringify({ checks: checks.length, failed, consoleErrors, pageErrors }, null, 2))
process.exit(failed.length || consoleErrors.length || pageErrors.length ? 1 : 0)
