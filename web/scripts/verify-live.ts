#!/usr/bin/env bun
// Check 4 (live): against a mock started WITHOUT --no-live (MOCK_TICK_MS=2000), verify the Activity feed appends
// messages while the header + tabs stay put, and home rows keep their height.
//   bun scripts/verify-live.ts [--url http://127.0.0.1:4184] [--project plutus]
import { parseArgs } from 'node:util'
import puppeteer, { type Page } from 'puppeteer-core'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' }, project: { type: 'string' } } })
const URL_ = values.url ?? 'http://127.0.0.1:4184'
const PROJECT = values.project ?? 'plutus'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const checks: { name: string; ok: boolean; detail?: string }[] = []
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
const box = (page: Page, sel: string) => page.$eval(sel, (el: Element) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })
const near = (a: any, b: any) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('sparrow.theme', 'light') } catch { /* */ } })
const errors: string[] = []
page.on('pageerror', (e) => errors.push(String(e)))
const go = async (h: string) => { await page.goto(`${URL_}/#/${h}?p=${PROJECT}`, { waitUntil: 'networkidle2' }).catch(() => {}); await sleep(900) }

// --- captain page: header + tabs stay put while messages append
await go('captain/ag_cap')
const msgCount0 = await page.evaluate(() => document.querySelectorAll('[data-kind]').length)
const head0 = await box(page, '[data-testid="title"]')
const tabs0 = await box(page, '[role="tablist"][aria-label="Captain"]')
await sleep(7000) // 3+ ticks at 2000ms
const msgCount1 = await page.evaluate(() => document.querySelectorAll('[data-kind]').length)
const head1 = await box(page, '[data-testid="title"]')
const tabs1 = await box(page, '[role="tablist"][aria-label="Captain"]')
check('activity appends messages', msgCount1 > msgCount0, `${msgCount0} → ${msgCount1}`)
check('header does not move', near(head0, head1), JSON.stringify({ head0, head1 }))
check('tabs do not move', near(tabs0, tabs1), JSON.stringify({ tabs0, tabs1 }))

// --- home rows keep their height
await go('captains')
const rows0 = await page.evaluate(() => [...document.querySelectorAll('[data-captain-row]')].slice(0, 5).map((r) => Math.round(r.getBoundingClientRect().height)))
await sleep(7000)
const rows1 = await page.evaluate(() => [...document.querySelectorAll('[data-captain-row]')].slice(0, 5).map((r) => Math.round(r.getBoundingClientRect().height)))
check('home rows keep their height', JSON.stringify(rows0) === JSON.stringify(rows1), `${JSON.stringify(rows0)} vs ${JSON.stringify(rows1)}`)

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | ') || undefined)
await browser.close()
const failed = checks.filter((c) => !c.ok)
console.log(JSON.stringify({ checks: checks.length, failed }, null, 2))
process.exit(failed.length ? 1 : 0)
