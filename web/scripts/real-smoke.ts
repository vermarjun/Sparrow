#!/usr/bin/env bun
// Smoke the UI against the REAL Sparrow server (T1) + spawner (T2) with the `fake` harness.
// Fully isolated: temp SPARROW_HOME, port 4144, tmux socket -L sparrow-test-T4, prefix sptest-.
//   bun scripts/real-smoke.ts [--keep]   (--keep leaves the server up for manual browsing)
// Then screenshots via scripts/shots.ts (prefix real-) and checks a UI drag changes only the card.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 4144
const SOCKET = 'sparrow-test-T4'
const home = mkdtempSync(join(tmpdir(), 'sparrow-t4-'))
Object.assign(process.env, {
  SPARROW_HOME: home, SPARROW_PORT: String(PORT), SPARROW_URL: `http://127.0.0.1:${PORT}`,
  SPARROW_TMUX_SOCKET: SOCKET, SPARROW_TMUX_PREFIX: 'sptest-',
  SPARROW_SETTINGS: JSON.stringify({ close_grace_ms: 1500, watchdog_ms: 1000, snapshot_ms: 2000, max_running: 3 }),
})
const keep = Bun.argv.includes('--keep')
const U = `http://127.0.0.1:${PORT}`
const sleep = (ms: number) => Bun.sleep(ms)

// resumes + a git project dir
mkdirSync(join(home, 'resumes'), { recursive: true })
const resume = (slug: string, title: string, canHire: string[]) =>
  writeFileSync(join(home, 'resumes', `${slug}.md`), `---\nname: ${slug}\ntitle: ${title}\ndescription: ${title} on the fake harness (tests).\nharness: fake\ncan_hire: [${canHire.join(', ')}]\nlimits: { quiet_minutes: 1, max_call_minutes: 90 }\n---\nYou are a ${title}.\n`)
resume('fake-lead', 'Fake lead', ['fake-builder'])
resume('fake-builder', 'Fake builder', [])
const proj = join(home, 'ledger-demo')
mkdirSync(proj)
Bun.spawnSync(['git', 'init', '-q', proj])

const { startServer } = await import('../../src/server/main')
const server = await startServer({ port: PORT, webDist: join(import.meta.dir, '..', 'dist'), log: () => {} })

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
  const { agent: cap, project } = await call('POST', '/api/captains/register', { cwd: proj })
  const P = project.id as string
  console.log(`project ${P}, captain ${cap.id}`)
  // A lead that stays busy, two builders that report, one that crashes.
  const lead = (await call('POST', '/api/hire', { resume: 'fake-lead', name: 'maya', cwd: proj, task: 'Plan the CSV export.\nFAKE:update planning the export, hiring builders\nFAKE:sleep 120' }, cap.id)).agent
  await call('POST', '/api/hire', { resume: 'fake-builder', name: 'james', cwd: proj, task: 'Write the CSV writer.\nFAKE:update writer done, 14/14 tests pass\nFAKE:done CSV writer shipped. `bun test` 14 pass.' }, cap.id)
  await call('POST', '/api/hire', { resume: 'fake-builder', name: 'iris', cwd: proj, task: 'Verify PR #41.\nFAKE:update starting verification\nFAKE:crash 3' }, cap.id)
  await call('POST', '/api/cards', { project: P, title: 'CSV export for the ledger', details: 'Stream rows, RFC 4180 quoting.', category: 'export', state: 'in_progress' })
  await call('POST', '/api/cards', { project: P, title: 'Date-range picker', category: 'ui', state: 'todo' })
  await call('POST', '/api/cards', { project: P, title: 'Rate-limit /api/export', category: 'server', state: 'todo' })
  await sleep(1500)
  await call('POST', '/api/propose', { title: 'Progress header for long exports', category: 'export' }, lead.id)
  await call('POST', '/api/send', { to: 'group', text: '@james thanks; @iris please re-run once it is merged' }, lead.id).catch((e) => console.log('send:', e.message))

  // let the fake agents run (done → window closes; crash → restart → crash → crashed)
  for (let i = 0; i < 30; i++) {
    const agents = await call<any[]>('GET', `/api/agents?project=${P}`)
    const s = Object.fromEntries(agents.map((a) => [a.handle, a.state]))
    if (s.james === 'idle' && (s.iris === 'idle' || s.iris === 'crashed')) break
    await sleep(1000)
  }
  const agents = await call<any[]>('GET', `/api/agents?project=${P}`)
  console.log('states:', agents.map((a) => `@${a.handle}=${a.state}`).join(' '))

  // UI checks: screenshots + a drag; the drag must change only the card.
  const before = {
    msgs: (await call<any[]>('GET', `/api/messages?project=${P}&limit=1000`)).length,
    agents: JSON.stringify((await call<any[]>('GET', `/api/agents?project=${P}`)).map((a) => [a.id, a.state, a.call_id])),
    cards: await call<any[]>('GET', `/api/cards?project=${P}`),
  }
  // async spawn: this process hosts the server, a sync spawn would block it
  const shots = Bun.spawn(['bun', join(import.meta.dir, 'shots.ts'), '--url', U, '--project', P, '--prefix', 'real-', '--card', String(before.cards[0].id), '--dm', '@captain ↔ @james', '--dm2', '@captain ↔ @iris', '--agent', 'maya', '--agent2', 'iris'], { stdout: 'pipe', stderr: 'pipe' })
  const [shotsOut, shotsErr, shotsCode] = await Promise.all([new Response(shots.stdout).text(), new Response(shots.stderr).text(), shots.exited])
  const summary = JSON.parse(shotsOut || '{}')
  check('UI loads (Board, Chat, Agents, peek) with no console/page errors', shotsCode === 0 && !summary.consoleErrors?.length && !summary.pageErrors?.length, JSON.stringify({ c: summary.consoleErrors, p: summary.pageErrors, err: shotsCode ? shotsErr.slice(-500) : '' }))
  const after = {
    msgs: (await call<any[]>('GET', `/api/messages?project=${P}&limit=1000`)).length,
    agents: JSON.stringify((await call<any[]>('GET', `/api/agents?project=${P}`)).map((a) => [a.id, a.state, a.call_id])),
    cards: await call<any[]>('GET', `/api/cards?project=${P}`),
  }
  const moved = after.cards.filter((c) => { const b = before.cards.find((x) => x.id === c.id); return b && (b.state !== c.state || b.position !== c.position) })
  check('drag moved exactly one card', moved.length === 1, moved.map((c) => `#${c.id} → ${c.state} @${c.position}`).join(', '))
  check('drag sent no messages', after.msgs === before.msgs, `${before.msgs} → ${after.msgs}`)
  check('drag spawned nothing (agent states/calls unchanged, maya still working)', after.agents === before.agents)
  const screen = await call('GET', `/api/agents/${lead.id}/screen`)
  check('screen peek of a working agent is live', screen.live === true && screen.text.length > 0, screen.text.trim().split('\n').slice(-2).join(' | '))
} catch (e) {
  ok = false
  console.error('ERROR', e)
} finally {
  if (keep) {
    console.log(`server up at ${U} (SPARROW_HOME=${home}); Ctrl-C to stop`)
  } else {
    await server.stop()
    Bun.spawnSync(['tmux', '-L', SOCKET, 'kill-server'], { stderr: 'ignore' })
    Bun.spawnSync(['trash', home], { stderr: 'ignore' })
    console.log(ok ? 'REAL SMOKE OK' : 'REAL SMOKE FAILED')
    process.exit(ok ? 0 : 1)
  }
}
