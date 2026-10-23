#!/usr/bin/env bun
import { chromeExecutable } from './browser'
// Independent verification of the Captains UI (spec docs/DESIGN.md).
//   bun scripts/verify-captains.ts [--url http://127.0.0.1:4183] [--out ../.sandbox/shots/captains/verify] [--project tortuga]
// Screenshots every route in light + dark at 1440x900 and 390x844; asserts no horizontal scroll, no console/page errors
// (ignores only the mock's missing /api/skills 404, which we stub anyway so the Skills page renders). Then keyboard,
// accessibility (icon-only buttons lacking aria-label, focus ring) checks. Mutations (title edit, new captain) run last.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer, { type Page } from 'puppeteer-core'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { url: { type: 'string' }, out: { type: 'string' }, project: { type: 'string' } },
})
const URL_ = values.url ?? process.env.SPARROW_WEB_URL ?? 'http://127.0.0.1:4183'
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.sandbox/shots/captains/verify'))
const PROJECT = values.project ?? process.env.SPARROW_DEMO_PROJECT ?? 'tortuga'
const CHROME = chromeExecutable()
const THEMES = ['light', 'dark'] as const
const SIZES = [{ w: 1440, h: 900 }, { w: 390, h: 844 }] as const
mkdirSync(OUT, { recursive: true })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const checks: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); console.error(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

// Skills fixture so the Skills page renders (the mock has no /api/skills; the task says to ignore only that 404).
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

const routes: { name: string; hash: string }[] = [
  { name: 'home', hash: 'captains' },
  { name: 'captain-ag_cap-activity', hash: 'captain/ag_cap' },
  { name: 'captain-ag_orion-team', hash: 'captain/ag_orion?tab=team' },
  { name: 'captain-ag_orion-sheet', hash: 'captain/ag_orion?tab=team&agent=ag_sage' },
  { name: 'captain-ag_cap-cards', hash: 'captain/ag_cap?tab=cards' },
  { name: 'captain-ag_vega', hash: 'captain/ag_vega' },
  { name: 'board', hash: 'board' },
  { name: 'resumes', hash: 'resumes' },
  { name: 'resumes-builder', hash: 'resumes/builder' },
  { name: 'skills', hash: 'skills' },
  { name: 'doctor', hash: 'doctor' },
  { name: 'settings', hash: 'settings' },
]
const redirects: { name: string; hash: string }[] = [
  { name: 'chat', hash: 'chat' },
  { name: 'agents', hash: 'agents' },
]

const isSkill404 = (t: string) => t.includes('/api/skills') && (t.includes('404') || t.includes('Failed to load resource'))
// GET /api/resumes/<slug>/test answers 404 until a test has run: the editor expects it.
const isNoTestRun = (url: string) => /\/api\/resumes\/[^/]+\/test(\?|$)/.test(url)

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })

async function newPage(theme: 'light' | 'dark', size: { w: number; h: number }) {
  const page = await browser.newPage()
  await page.setViewport({ width: size.w, height: size.h, deviceScaleFactor: 1, hasTouch: size.w < 600 })
  await page.evaluateOnNewDocument((t) => { try { localStorage.setItem('sparrow.theme', t); localStorage.removeItem('sparrow.sidebar') } catch { /* */ } }, theme)
  await page.setRequestInterception(true)
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname
    if (p === '/api/skills') void r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(SKILLS) })
    else if (p === '/api/skills/updates') void r.respond({ status: 200, contentType: 'application/json', body: '[]' })
    else if (p === '/api/skills/matrix') void r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ resumes: [], skills: [], cells: {} }) })
    else void r.continue()
  })
  return page
}

const go = async (page: Page, hash: string) => {
  await page.goto(`${URL_}/#/${hash}${hash.includes('?') ? '&' : '?'}p=${PROJECT}`, { waitUntil: 'networkidle2' }).catch(() => {})
  await page.waitForFunction(() => document.readyState === 'complete')
  await sleep(700)
}
const scrollWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth)
const hash = (page: Page) => page.evaluate(() => location.hash)

// ---------------------------------------------------------------- screenshots (check 2)
interface ErrBag { console: string[]; pageerr: string[]; resp: string[] }
for (const theme of THEMES) {
  for (const size of SIZES) {
    const page = await newPage(theme, size)
    const bag: ErrBag = { console: [], pageerr: [], resp: [] }
    page.on('console', (m) => { if (m.type() === 'error' && !isSkill404(m.text()) && !isNoTestRun(m.location().url ?? '')) bag.console.push(m.text()) })
    page.on('pageerror', (e) => bag.pageerr.push(String(e)))
    page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/api/skills') && !isNoTestRun(r.url())) bag.resp.push(`${r.status()} ${r.url()}`) })

    for (const r of routes) {
      bag.console.length = 0; bag.pageerr.length = 0; bag.resp.length = 0
      await go(page, r.hash)
      const w = await scrollWidth(page)
      check(`${r.name} [${theme} ${size.w}] no errors`, bag.console.length === 0 && bag.pageerr.length === 0 && bag.resp.length === 0,
        [...bag.console, ...bag.pageerr, ...bag.resp].slice(0, 3).join(' | ') || undefined)
      check(`${r.name} [${theme} ${size.w}] no h-scroll`, w <= size.w, `scrollWidth ${w}`)
      await page.screenshot({ path: join(OUT, `${r.name}-${theme}-${size.w}.png`) })
    }
    for (const r of redirects) {
      await go(page, r.hash)
      const h = await hash(page)
      check(`${r.name} [${theme} ${size.w}] redirects to captains`, h.startsWith('#/captains'), h)
    }
    await page.close()
  }
}

// ---------------------------------------------------------------- keyboard (check 3, light desktop)
{
  const page = await newPage('light', { w: 1440, h: 900 })
  const bag: ErrBag = { console: [], pageerr: [], resp: [] }
  page.on('console', (m) => { if (m.type() === 'error' && !isSkill404(m.text()) && !isNoTestRun(m.location().url ?? '')) bag.console.push(m.text()) })
  page.on('pageerror', (e) => bag.pageerr.push(String(e)))
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/api/skills') && !isNoTestRun(r.url())) bag.resp.push(`${r.status()} ${r.url()}`) })
  const active = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? '')
  const press = async (key: string, mod?: 'Meta') => { if (mod) await page.keyboard.down(mod); await page.keyboard.press(key as never); if (mod) await page.keyboard.up(mod); await sleep(250) }
  const asideW = () => page.evaluate(() => Math.round(document.querySelector('aside')!.getBoundingClientRect().width))

  await go(page, 'captains')
  await press('k', 'Meta'); check('⌘K opens palette', await page.evaluate(() => !!document.querySelector('[role=dialog] [cmdk-input], [cmdk-root]')))
  await press('k', 'Meta'); check('⌘K closes palette', !(await page.evaluate(() => !!document.querySelector('[role=dialog] [cmdk-input], [cmdk-root]'))))
  await press('k', 'Meta'); await page.keyboard.type('vega'); await sleep(250); await press('Enter')
  check('⌘K type vega + Enter opens cap-vega', (await hash(page)).includes('captain/ag_vega'), await hash(page))
  await go(page, 'captains')

  const w0 = await asideW(); await press('b', 'Meta'); await sleep(300); const w1 = await asideW(); await press('b', 'Meta'); await sleep(300); const w2 = await asideW()
  check('⌘B collapses/restores sidebar', w0 === 260 && w1 === 56 && w2 === 260, `${w0}→${w1}→${w2}`)

  await press('/'); check('/ focuses sidebar search', (await active()) === 'Search captains', await active())

  // home j/k + Enter
  await go(page, 'captains')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await press('j'); await press('j')
  const idx = await page.evaluate(() => [...document.querySelectorAll('[data-captain-row]')].findIndex((r) => r.hasAttribute('data-focused')))
  check('home j j focuses second row', idx === 1, `index ${idx}`)
  await press('k'); await press('Enter')
  check('home k then Enter opens first captain', (await hash(page)).startsWith('#/captain/'), await hash(page))

  // captain page 1/2/3 tabs
  await go(page, 'captain/ag_cap')
  await press('2'); check('key 2 → team tab', (await hash(page)).includes('tab=team'), await hash(page))
  await press('3'); check('key 3 → cards tab', (await hash(page)).includes('tab=cards'), await hash(page))
  await press('1'); check('key 1 → activity tab', !(await hash(page)).includes('tab='), await hash(page))

  // team rows j/k + Enter → agent sheet, Esc closes
  await go(page, 'captain/ag_orion?tab=team')
  await page.evaluate(() => { const r = document.querySelector('[data-row][data-agent]') as HTMLElement | null; r?.focus() })
  await press('j'); await press('Enter'); await sleep(400)
  check('team j + Enter opens agent sheet', (await hash(page)).includes('agent='), await hash(page))
  await press('Escape'); await sleep(300)
  check('Esc closes agent sheet', !(await hash(page)).includes('agent='), await hash(page))

  // title edit: Enter saves (sidebar row updates), Esc cancels. Clicking selects the whole title, so typing replaces it.
  await go(page, 'captain/ag_cap')
  await page.click('[data-testid="title"]'); await sleep(200)
  await page.keyboard.type('CSV export v3')
  await press('Enter'); await sleep(400)
  const savedTitle = await page.evaluate(() => document.querySelector('[data-testid="title"]')?.textContent?.trim() ?? '')
  check('title Enter saves (header shows new title)', savedTitle === 'CSV export v3', savedTitle)
  const sidebarRow = await page.evaluate(() => [...document.querySelectorAll('aside [data-row]')].map((r) => r.textContent ?? '').find((t) => t.includes('CSV export v3')))
  check('title save updates the sidebar row', !!sidebarRow, sidebarRow)
  await page.click('[data-testid="title"]'); await sleep(200)
  await page.keyboard.type(' SHOULD NOT STICK'); await press('Escape'); await sleep(300)
  const afterEsc = await page.evaluate(() => document.querySelector('[data-testid="title"]')?.textContent?.trim() ?? '')
  check('title Esc cancels (reverts to saved)', afterEsc === 'CSV export v3', afterEsc)

  // New captain: empty title error, then valid submit creates + navigates
  await go(page, 'captains')
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'New captain'); (b as HTMLElement)?.click() })
  await sleep(500)
  await press('Enter'); await sleep(250)
  check('New captain empty title → inline error', await page.evaluate(() => !!document.querySelector('#nc-title-err')?.textContent))
  await page.keyboard.type('Retry storm in the exporter'); await sleep(150)
  await press('Enter'); await sleep(900)
  check('New captain valid submit navigates to new captain', (await hash(page)).startsWith('#/captain/'), await hash(page))
  check('New captain toast offers Copy tmux attach', await page.evaluate(() => document.body.textContent?.includes('Copy tmux attach') ?? false))
  check('keyboard run: no console/page errors', bag.console.length === 0 && bag.pageerr.length === 0 && bag.resp.length === 0,
    [...bag.console, ...bag.pageerr, ...bag.resp].slice(0, 3).join(' | ') || undefined)
  await page.close()
}

// ---------------------------------------------------------------- accessibility (check 6, light desktop)
{
  const page = await newPage('light', { w: 1440, h: 900 })
  await go(page, 'captains')
  const homeBad = await page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((b) => b.textContent!.trim() === '' && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby'))
    .map((b) => b.outerHTML.slice(0, 120)))
  check('home: no icon-only button without aria-label', homeBad.length === 0, homeBad.join(' | ') || undefined)
  await go(page, 'captain/ag_cap')
  const capBad = await page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((b) => b.textContent!.trim() === '' && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby'))
    .map((b) => b.outerHTML.slice(0, 120)))
  check('captain page: no icon-only button without aria-label', capBad.length === 0, capBad.join(' | ') || undefined)

  // focus ring: tab from body onto the first control and confirm :focus-visible + a real ring
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Tab'); await sleep(200)
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement
    if (!el) return { ok: false, detail: 'no active element' }
    const cs = getComputedStyle(el)
    const shadow = cs.boxShadow
    const hasRing = el.matches(':focus-visible') && /oklab|rgb/ .test(shadow) && /0px 0px 0px [1-9]/.test(shadow)
    return { ok: hasRing, detail: `${el.tagName} fv=${el.matches(':focus-visible')} shadow=${shadow}` }
  })
  check('tabbing shows a visible focus ring', ring.ok, ring.detail)
  await page.close()
}

await browser.close()
const failed = checks.filter((c) => !c.ok)
console.log(JSON.stringify({ checks: checks.length, failed, shotsDir: OUT }, null, 2))
process.exit(failed.length ? 1 : 0)
