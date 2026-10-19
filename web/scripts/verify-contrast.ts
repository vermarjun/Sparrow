#!/usr/bin/env bun
// Contrast audit: convert computed oklch/oklab/rgb colors to sRGB and flag text below WCAG 4.5:1 (3:1 large).
//   bun scripts/verify-contrast.ts [--url http://127.0.0.1:4183] [--project plutus]
import { parseArgs } from 'node:util'
import puppeteer from 'puppeteer-core'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' }, project: { type: 'string' } } })
const URL_ = values.url ?? 'http://127.0.0.1:4183'
const PROJECT = values.project ?? 'plutus'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const routes = ['captains', 'captain/ag_cap', 'captain/ag_orion?tab=team', 'captain/ag_orion?tab=team&agent=ag_zoe', 'captain/ag_cap?tab=cards', 'board', 'resumes', 'skills', 'doctor', 'settings']

const fn = () => {
  const out: any = { total: 0, worst: [] }
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  const toSrgb = (c: string): [number, number, number] | null => {
    const m = c.match(/[\d.eE+-]+/g)
    if (!m) return null
    const n = m.map(Number)
    if (c.startsWith('rgb')) return [n[0] / 255, n[1] / 255, n[2] / 255]
    if (c.startsWith('hsl')) { const [h, s, l] = n; const k = (n2: number) => (n2 + h / 30) % 12; const a = s * Math.min(l, 1 - l); const f = (n2: number) => l - a * Math.max(-1, Math.min(k(n2) - 3, Math.min(9 - k(n2), 1))); return [f(0), f(8), f(4)] }
    // oklch(L C H) or oklab(L a b)
    if (c.startsWith('oklch')) { const [L, C, H] = n; return oklabToSrgb([L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)]) }
    if (c.startsWith('oklab')) return oklabToSrgb([n[0], n[1], n[2]])
    return null
  }
  const oklabToSrgb = (lab: [number, number, number]): [number, number, number] => {
    const [L, a, b] = lab
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b
    const s_ = L - 0.0894841775 * a - 1.291485548 * b
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
    let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    let bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    const lin = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
    return [clamp01(lin(r)), clamp01(lin(g)), clamp01(lin(bl))]
  }
  const lum = (c: [number, number, number]) => { const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
  const ratio = (fg: [number, number, number], bg: [number, number, number]) => { const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const effBg = (el: Element): [number, number, number] | null => {
    let n: Element | null = el
    while (n) {
      const bg = getComputedStyle(n).backgroundColor
      const c = toSrgb(bg)
      if (c) { const alpha = parseFloat((bg.match(/[\d.]+/g) || ['1']).slice(-1)[0]); if ((bg.match(/[\d.]+/g) || []).length < 4 || alpha > 0.05) return c }
      n = n.parentElement
    }
    return null
  }
  const walk = (el: Element) => {
    for (const child of el.children) {
      const cs = getComputedStyle(child)
      const txt = (child.textContent || '').trim()
      if (txt && child.children.length === 0 && cs.display !== 'none' && cs.visibility !== 'hidden') {
        const fg = toSrgb(cs.color)
        if (fg) {
          const bg = effBg(child)
          if (bg) {
            const r = ratio(fg, bg)
            const size = parseFloat(cs.fontSize) || 14
            const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight) >= 700)
            if (r < (large ? 3 : 4.5)) out.worst.push({ r: Math.round(r * 100) / 100, size: Math.round(size), fg: cs.color, text: txt.slice(0, 34) })
          }
        }
      }
      walk(child)
    }
  }
  walk(document.body)
  out.worst.sort((a: any, b: any) => a.r - b.r)
  out.total = out.worst.length
  out.worst = out.worst.slice(0, 10)
  return out
}

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })
for (const theme of ['dark', 'light']) {
  for (const w of [1440, 390]) {
    const page = await browser.newPage()
    await page.setViewport({ width: w, height: w === 1440 ? 900 : 844, deviceScaleFactor: 1, hasTouch: w < 600 })
    await page.evaluateOnNewDocument((t) => { try { localStorage.setItem('sparrow.theme', t) } catch { /* */ } }, theme)
    for (const r of routes) {
      await page.goto(`${URL_}/#/${r}${r.includes('?') ? '&' : '?'}p=${PROJECT}`, { waitUntil: 'networkidle2' }).catch(() => {})
      await sleep(650)
      const a = await page.evaluate(fn)
      console.log(`${theme} ${w} ${r}: ${a.total} low-contrast`)
      for (const wc of a.worst) console.log(`   ${wc.r}:1 ${wc.size}px ${wc.fg} "${wc.text}"`)
    }
    await page.close()
  }
}
await browser.close()
