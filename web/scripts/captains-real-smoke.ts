#!/usr/bin/env bun
import { chromeExecutable } from './browser'
// Smoke the Captains UI against the REAL Sparrow server (src/server) with the `fake` harness.
// Fully isolated: SPARROW_HOME under ../.sandbox/real-smoke, a free port (never 4040), its own tmux socket + prefix.
//   bun scripts/captains-real-smoke.ts --dist <built web dir> [--out <shots dir>] [--keep]
// Two captains in one project (separate session ids → @captain and @cap-…), each with its own fleet; the first has a
// lead that hires a builder (nested fleet). Then the UI is driven with puppeteer: home, captain page tabs, agent sheet, ⌘K.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer from 'puppeteer-core'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { dist: { type: 'string' }, out: { type: 'string' }, keep: { type: 'boolean' } } })
const DIST = resolve(values.dist ?? join(import.meta.dir, '..', 'dist'))
const OUT = resolve(values.out ?? join(import.meta.dir, '../../.sandbox/shots/captains'))
const free = () => { const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); const p = s.port; s.stop(true); return p }
const PORT = free()
const SOCKET = `sparrow-captains-smoke-${PORT}`
const home = resolve(join(import.meta.dir, '../../.sandbox/real-smoke', String(PORT)))
mkdirSync(home, { recursive: true })
Object.assign(process.env, {
  SPARROW_SKILLS_HOME: join(home, 'skills'), SPARROW_HOME: home, SPARROW_PORT: String(PORT), SPARROW_URL: `http://127.0.0.1:${PORT}`,
  SPARROW_TMUX_SOCKET: SOCKET, SPARROW_TMUX_PREFIX: 'capsmoke-',
  SPARROW_SETTINGS: JSON.stringify({ close_grace_ms: 1500, watchdog_ms: 1000, snapshot_ms: 2000, max_running: 4 }),
})
delete process.env.SPARROW_AGENT_ID; delete process.env.SPARROW_CALL_ID; delete process.env.SPARROW_CAPTAIN_ID
if (PORT === 4040) throw new Error('refusing port 4040')
const U = `http://127.0.0.1:${PORT}`
const sleep = (ms: number) => Bun.sleep(ms)
mkdirSync(OUT, { recursive: true })

mkdirSync(join(home, 'resumes'), { recursive: true })
const resume = (slug: string, title: string, canHire: string[]) =>
  writeFileSync(join(home, 'resumes', `${slug}.md`), `---\nname: ${slug}\ntitle: ${title}\ndescription: ${title} on the fake harness.\nharness: fake\ncan_hire: [${canHire.join(', ')}]\nlimits: { quiet_minutes: 5, max_call_minutes: 90 }\n---\nYou are a ${title}.\n`)
resume('fake-lead', 'Fake lead', ['fake-builder'])
resume('fake-builder', 'Fake builder', [])
const proj = join(home, 'ledger-demo')
mkdirSync(proj, { recursive: true })
Bun.spawnSync(['git', 'init', '-q', '-b', 'feat/csv-export', proj])

const { startServer } = await import('../../src/server/main')
const server = await startServer({ port: PORT, webDist: DIST, log: () => {} })

async function call<T = any>(method: string, path: string, body?: unknown, agent?: string): Promise<T> {
  const res = await fetch(U + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(agent ? { 'x-sparrow-agent': agent } : {}) },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`)
  return data as T
}

let ok = true
const check = (label: string, cond: boolean, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); ok &&= cond }

try {
  const a = await call('POST', '/api/captains/register', { cwd: proj, harness: 'claude', session_id: crypto.randomUUID() })
  const b = await call('POST', '/api/captains/register', { cwd: proj, harness: 'claude', session_id: crypto.randomUUID() })
  const P = a.project.id as string
  check('two sessions → two captains', a.agent.id !== b.agent.id && a.agent.handle === 'captain' && b.agent.handle.startsWith('cap-'), `${a.agent.handle}, ${b.agent.handle}`)
  await call('PATCH', `/api/captains/${a.agent.id}`, { title: 'CSV export for the ledger' })
  await call('PATCH', `/api/captains/${b.agent.id}`, { title: 'Rate limiting for login' })
  const lead = (await call('POST', '/api/hire', { resume: 'fake-lead', name: 'maya', cwd: proj, task: 'Own the CSV export.\nFAKE:update planning the export, hiring a builder\nFAKE:sleep 120' }, a.agent.id)).agent
  await call('POST', '/api/hire', { resume: 'fake-builder', name: 'james', cwd: proj, task: 'Write the CSV writer.\nFAKE:update writer done, 14/14 tests pass\nFAKE:done ## Result\nCSV writer shipped.\n## Evidence\n`bun test` 14 pass.' }, lead.id)
  await call('POST', '/api/hire', { resume: 'fake-builder', name: 'iris', cwd: proj, task: 'Verify PR #41.\nFAKE:update starting verification\nFAKE:done_failed 3 of 41 tests fail.' }, a.agent.id)
  await call('POST', '/api/hire', { resume: 'fake-builder', name: 'zoe', cwd: proj, task: 'Build the login limiter.\nFAKE:update limiter wired into POST /login\nFAKE:ask Reset the counter on a successful login?' }, b.agent.id)
  for (let i = 0; i < 30; i++) {
    const s = Object.fromEntries((await call<any[]>('GET', `/api/agents?project=${P}`)).map((x) => [x.handle, x.state]))
    if (s.james === 'idle' && s.iris === 'idle' && s.zoe === 'waiting') break
    await sleep(1000)
  }
  const agents = await call<any[]>('GET', `/api/agents?project=${P}`)
  console.log('states:', agents.map((x) => `@${x.handle}=${x.state}/${x.fleet_id === a.agent.id ? 'A' : x.fleet_id === b.agent.id ? 'B' : '?'}`).join(' '))
  check('every agent carries its fleet', agents.every((x) => x.fleet_id === a.agent.id || x.fleet_id === b.agent.id))
  check('the builder hired by the lead is in the first fleet', agents.find((x) => x.handle === 'james')?.fleet_id === a.agent.id)
  const caps = await call<any[]>('GET', `/api/captains?project=${P}`)
  console.log('captains:', caps.map((s) => `@${s.agent.handle} ${s.status} fleet=${s.fleet.total} unread=${s.unread} q=${s.questions}`).join(' · '))
  check('/api/captains lists both with fleet counts', caps.length === 2 && caps.some((s) => s.fleet.total === 3) && caps.some((s) => s.fleet.total === 1))
  const projects = await call<any[]>('GET', '/api/projects')
  check('/api/projects rows carry captains', projects.find((p) => p.id === P)?.captains === 2)
  const fleetMsgs = await call<any[]>('GET', `/api/messages?project=${P}&fleet=${b.agent.id}&limit=2000`)
  check('?fleet= returns only that fleet', fleetMsgs.length > 0 && fleetMsgs.every((m) => !m.thread.includes(lead.id)), `${fleetMsgs.length} msgs`)

  // ---------------------------------------------------------------- UI
  const browser = await puppeteer.launch({ executablePath: chromeExecutable(), headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.evaluateOnNewDocument(() => localStorage.setItem('sparrow.theme', 'light'))
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  const go = async (hash: string) => { await page.goto(`${U}/${hash}`, { waitUntil: 'networkidle2' }).catch(() => {}); await sleep(900) }
  const text = () => page.evaluate(() => document.body.innerText)

  await go(`#/captains?p=${P}`)
  let t = await text()
  check('home lists both captains by title', t.includes('CSV export for the ledger') && t.includes('Rate limiting for login'))
  await page.screenshot({ path: join(OUT, 'real-home-light.png') })

  await go(`#/captain/${a.agent.id}?p=${P}`)
  t = await text()
  check('captain page shows its activity (task + result)', t.includes('Own the CSV export') && /CSV writer shipped|3 of 41/.test(t))
  check('captain page does not show the other fleet', !t.includes('Build the login limiter'))
  await page.screenshot({ path: join(OUT, 'real-captain-activity-light.png') })

  await go(`#/captain/${a.agent.id}?tab=team&p=${P}`)
  t = await text()
  check('team tab shows the nested fleet', ['@maya', '@james', '@iris'].every((h) => t.includes(h)) && !t.includes('@zoe'))
  await page.screenshot({ path: join(OUT, 'real-captain-team-light.png') })

  await go(`#/captain/${a.agent.id}?tab=team&agent=${lead.id}&p=${P}`)
  await sleep(2500)
  t = await text()
  check('agent sheet opens with a screen peek for the working lead', t.includes('@maya') && /Screen/i.test(t))
  await page.screenshot({ path: join(OUT, 'real-agent-sheet-light.png') })

  await go(`#/captain/${b.agent.id}?p=${P}`)
  t = await text()
  check('second captain: the question is shown and it needs you', t.includes('Reset the counter on a successful login?'))

  await go(`#/captains?p=${P}`)
  await page.keyboard.down('Meta'); await page.keyboard.press('k'); await page.keyboard.up('Meta')
  await sleep(400)
  check('⌘K opens', await page.evaluate(() => !!document.querySelector('[cmdk-root], [cmdk-input]')))
  await page.keyboard.press('Escape')

  await go(`#/chat?p=${P}`)
  check('#/chat redirects to #/captains', (await page.evaluate(() => location.hash)).startsWith('#/captains'))
  await go(`#/board?p=${P}`)
  check('board renders', (await text()).includes('Board'))

  check('no console or page errors', errors.length === 0, errors.slice(0, 5).join(' | '))
  await browser.close()
} catch (e) {
  ok = false
  console.error('ERROR', e)
} finally {
  if (values.keep) {
    console.log(`server up at ${U} (SPARROW_HOME=${home}); Ctrl-C to stop`)
  } else {
    await server.stop()
    Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-server'], { stderr: 'ignore' })
    Bun.spawnSync(['trash', home], { stderr: 'ignore' })
    console.log(ok ? 'CAPTAINS REAL SMOKE OK' : 'CAPTAINS REAL SMOKE FAILED')
    process.exit(ok ? 0 : 1)
  }
}
