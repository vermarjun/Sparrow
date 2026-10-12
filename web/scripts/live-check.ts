#!/usr/bin/env bun
// Live-update check against the mock (it emits an update every MOCK_TICK_MS):
// 1) the group chat grows without a reload, 2) the agents table shows the new last update,
// 3) after the mock is restarted the page reconnects (dot back to "live").
//   bun scripts/live-check.ts   (starts its own mock on :4145 with a 1.5 s tick)
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const PORT = 4145
const U = `http://127.0.0.1:${PORT}`
const mock = () => Bun.spawn(['bun', join(import.meta.dir, '../mock/server.ts'), '--port', String(PORT), '--quiet'], { env: { ...process.env, MOCK_TICK_MS: '1500' }, stdout: 'ignore', stderr: 'inherit' })
const up = async () => { for (let i = 0; i < 50; i++) { if (await fetch(`${U}/api/health`).then((r) => r.ok).catch(() => false)) return; await Bun.sleep(100) } throw new Error('mock down') }

let proc = mock()
await up()
let ok = true
const check = (label: string, cond: boolean, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`); ok &&= cond }

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
try {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${U}/#/chat?p=plutus`, { waitUntil: 'networkidle2' }).catch(() => {})
  await page.waitForSelector('[data-kind]')
  const count = () => page.$$eval('[data-kind]', (els) => els.length)
  const n0 = await count()
  await Bun.sleep(4000)
  const n1 = await count()
  check('group chat appends live messages', n1 > n0, `${n0} → ${n1}`)
  const atBottom = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) => d.className.includes('overflow-y-auto') && d.querySelector('[data-kind]'))!
    return el.scrollHeight - el.scrollTop - el.clientHeight < 60
  })
  check('chat stays pinned to the bottom', atBottom)

  await page.goto(`${U}/#/agents?p=plutus`, { waitUntil: 'networkidle2' }).catch(() => {})
  await page.waitForSelector('[data-agent="james"]')
  const upd = () => page.$eval('[data-agent="james"]', (r) => r.lastElementChild?.textContent ?? '')
  const u0 = await upd()
  await Bun.sleep(3500)
  const u1 = await upd()
  check('agents row shows the latest update live', u0 !== u1, `${u0.slice(0, 40)} → ${u1.slice(0, 40)}`)

  proc.kill()
  await Bun.sleep(1500)
  const dot = () => page.evaluate(() => document.querySelector('header')?.textContent ?? '')
  check('shows offline when the server goes away', /offline|connecting/.test(await dot()))
  proc = mock()
  await up()
  let live = false
  for (let i = 0; i < 40 && !live; i++) { await Bun.sleep(500); live = /live$/.test((await dot()).trim()) }
  check('reconnects after the server restarts', live)
  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  proc.kill()
}
console.log(ok ? 'LIVE CHECK OK' : 'LIVE CHECK FAILED')
process.exit(ok ? 0 : 1)
