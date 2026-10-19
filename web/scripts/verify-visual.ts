#!/usr/bin/env bun
// Programmatic visual audit (the verifier model cannot read PNGs): detect light "slabs" in dark mode,
// low-contrast text, and elements clipped/pushed past the viewport. Runs against the mock on --url.
//   bun scripts/verify-visual.ts [--url http://127.0.0.1:4183] [--project plutus]
import { parseArgs } from 'node:util'
import puppeteer from 'puppeteer-core'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { url: { type: 'string' }, project: { type: 'string' } } })
const URL_ = values.url ?? 'http://127.0.0.1:4183'
const PROJECT = values.project ?? 'plutus'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const routes = [
  'captains', 'captain/ag_cap', 'captain/ag_orion?tab=team', 'captain/ag_orion?tab=team&agent=ag_zoe',
  'captain/ag_cap?tab=cards', 'captain/ag_altair', 'board', 'resumes', 'resumes/builder', 'skills', 'doctor', 'settings',
]

const AUDIT = () => {
  const res: { slabs: any[]; contrast: any[]; offscreen: any[]; clipped: any[] } = { slabs: [], contrast: [], offscreen: [], clipped: [] }
  const parse = (c: string) => { const m = c.match(/[\d.]+/g); if (!m) return null; const n = m.slice(0, 4).map(Number); return n.length >= 3 ? n : null }
  const lum = (r: number, g: number, b: number) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const contrast = (a: number[], b: number[]) => { const [l1, l2] = [lum(a[0], a[1], a[2]), lum(b[0], b[1], b[2])].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05) }
  const bodyCol = getComputedStyle(document.body).color
  const firstL = parseFloat((bodyCol.match(/[\d.]+/g) || ['1'])[0])
  const isDark = (getComputedStyle(document.documentElement).colorScheme === 'dark') || (bodyCol.includes('oklab') && firstL < 0.5)
  const effBg = (el: Element): number[] => {
    let n: Element | null = el
    while (n) {
      const bg = getComputedStyle(n).backgroundColor
      const p = parse(bg)
      if (p && p.length >= 4 && p[3] > 0.05) return p.slice(0, 3)
      n = n.parentElement
    }
    return isDark ? [12, 12, 12] : [250, 250, 250]
  }
  const all = [...document.querySelectorAll('body *')]
  for (const el of all) {
    const r = (el as HTMLElement).getBoundingClientRect()
    if (r.width < 8 || r.height < 8) continue
    const cs = getComputedStyle(el)
    if (isDark) {
      const bg = parse(cs.backgroundColor)
      if (bg && bg.length >= 4 && bg[3] > 0.9 && bg[0] > 235 && bg[1] > 235 && bg[2] > 235 && r.width * r.height > 500) {
        res.slabs.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 60), w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor, text: (el.textContent || '').trim().slice(0, 40) })
      }
    }
    if (r.right > document.documentElement.clientWidth + 2) {
      res.offscreen.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 50), right: Math.round(r.right), vw: document.documentElement.clientWidth, text: (el.textContent || '').trim().slice(0, 30) })
    }
    const isLeafText = el.children.length === 0 && (el.textContent || '').trim()
    if (isLeafText && (cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis') && el.scrollHeight > el.clientHeight + 3 && r.height > 12) {
      res.clipped.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 50), clientH: el.clientHeight, scrollH: el.scrollHeight, text: (el.textContent || '').trim().slice(0, 40) })
    }
    const col = parse(cs.color)
    if (isLeafText && col && col.length >= 4 && col[3] > 0.9) {
      const ratio = contrast(col.slice(0, 3), effBg(el))
      const size = parseFloat(cs.fontSize) || 14
      const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight) >= 700)
      const limit = large ? 3 : 4.5
      if (ratio < limit) res.contrast.push({ ratio: Math.round(ratio * 100) / 100, size: Math.round(size), text: (el.textContent || '').trim().slice(0, 30), cls: (el.className || '').toString().slice(0, 40) })
    }
  }
  return {
    slabs: res.slabs.slice(0, 12),
    contrast: { n: res.contrast.length, worst: res.contrast.sort((a, b) => a.ratio - b.ratio).slice(0, 12) },
    offscreen: res.offscreen.slice(0, 8),
    clipped: res.clipped.slice(0, 8),
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'], headless: true })
for (const theme of ['dark', 'light']) {
  for (const w of [1440, 390]) {
    const page = await browser.newPage()
    await page.setViewport({ width: w, height: w === 1440 ? 900 : 844, deviceScaleFactor: 1, hasTouch: w < 600 })
    await page.evaluateOnNewDocument((t) => { try { localStorage.setItem('sparrow.theme', t) } catch { /* */ } }, theme)
    for (const r of routes) {
      await page.goto(`${URL_}/#/${r}${r.includes('?') ? '&' : '?'}p=${PROJECT}`, { waitUntil: 'networkidle2' }).catch(() => {})
      await sleep(700)
      const a = await page.evaluate(AUDIT)
      const flags = []
      if (a.slabs.length) flags.push(`SLABS(${a.slabs.length})`)
      if (a.contrast.n > 0) flags.push(`contrast<4.5:${a.contrast.n}`)
      if (a.offscreen.length) flags.push(`OFFSCREEN(${a.offscreen.length})`)
      if (a.clipped.length) flags.push(`CLIPPED(${a.clipped.length})`)
      const line = `${theme} ${w} ${r}: ${flags.length ? flags.join(' ') : 'clean'}`
      console.log(line)
      if (a.slabs.length) for (const s of a.slabs) console.log(`   slab  ${s.tag} ${s.cls} ${s.w}x${s.h} bg=${s.bg} "${s.text}"`)
      if (a.offscreen.length) for (const o of a.offscreen) console.log(`   offscreen ${o.tag} right=${o.right} vw=${o.vw} "${o.text}"`)
      if (a.clipped.length) for (const c of a.clipped) console.log(`   clipped ${c.tag} h=${c.clientH}→${c.scrollH} "${c.text}"`)
      if (a.contrast.worst.length) for (const c of a.contrast.worst) console.log(`   lowcontrast ${c.ratio}:1 ${c.size}px "${c.text}"`)
    }
    await page.close()
  }
}
await browser.close()
