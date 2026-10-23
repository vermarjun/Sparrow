#!/usr/bin/env bun
// Renders docs/diagrams/src/<name>.html to docs/images/<name>-{light,dark}.png (1280 CSS px wide, 2x, rounded corners transparent),
// checks WCAG AA contrast of every text node, then compresses with pngquant + oxipng.
//   bun docs/diagrams/render.ts [name ...] [--no-compress] [--no-check]
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from '../../web/node_modules/puppeteer-core'

const ROOT = import.meta.dir
const SRC = join(ROOT, 'src')
const OUT = join(ROOT, '../images')
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const args = Bun.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const named = args.filter((a) => !a.startsWith('--'))
const all = readdirSync(SRC).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')).sort()
const names = named.length ? named : all
for (const n of names) if (!all.includes(n)) throw new Error(`no source docs/diagrams/src/${n}.html (have: ${all.join(', ')})`)
mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--font-render-hinting=none'], headless: true })
const sizes: string[] = []
let failures = 0

for (const name of names) {
  for (const theme of ['light', 'dark'] as const) {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 2 })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    await page.goto(`file://${join(SRC, name + '.html')}?theme=${theme}`, { waitUntil: 'load' })
    await page.waitForFunction('window.__ready === true', { timeout: 15000 })
    if (errors.length) { console.error(`${name}-${theme}: page errors:\n  ${errors.join('\n  ')}`); failures++ }

    if (!flags.has('--no-check')) {
      const { bad, min, checked } = await page.evaluate(contrastCheck)
      console.log(`${name}-${theme}: ${checked} text nodes, lowest contrast ${min}:1`)
      for (const b of bad) { console.error(`${name}-${theme}: contrast ${b.ratio} < ${b.need} "${b.text}" (${b.fg} on ${b.bg})`); failures++ }
    }
    const box = await page.evaluate(() => { const r = document.querySelector('.frame')!.getBoundingClientRect(); return { x: r.x, y: r.y, width: Math.ceil(r.width), height: Math.ceil(r.height) } })
    const file = join(OUT, `${name}-${theme}.png`)
    await page.screenshot({ path: file, clip: box, omitBackground: true })
    await page.close()
    if (!flags.has('--no-compress')) {
      await run(['pngquant', '--quality=82-98', '--speed', '1', '--strip', '--force', '--output', file, file])
      await run(['oxipng', '-o', '4', '--strip', 'safe', '-q', file])
    }
    sizes.push(`${name}-${theme}.png  ${box.width * 2}x${box.height * 2}  ${(statSync(file).size / 1024).toFixed(0)} KB`)
  }
}
await browser.close()
console.log(sizes.join('\n'))
if (failures) { console.error(`${failures} problem(s)`); process.exit(1) }

async function run(cmd: string[]) {
  if (!Bun.which(cmd[0])) { console.warn(`(${cmd[0]} not installed, skipped)`); return }
  const p = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'pipe' })
  const err = await new Response(p.stderr).text()
  const code = await p.exited
  // pngquant exits 99 when it cannot reach the quality floor: keep the lossless PNG then.
  if (code !== 0 && !(cmd[0] === 'pngquant' && code === 99)) throw new Error(`${cmd[0]} failed (${code}): ${err}`)
}

// Runs in the page: WCAG contrast of each text node against the composited background behind it.
function contrastCheck() {
  type RGBA = [number, number, number, number]
  const parse = (s: string): RGBA => { const m = s.match(/[\d.]+/g)!.map(Number); return [m[0], m[1], m[2], m[3] ?? 1] }
  const over = (top: RGBA, bot: RGBA): RGBA => { const a = top[3] + bot[3] * (1 - top[3]); return [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / (a || 1)).concat(a) as RGBA }
  const lum = (c: RGBA) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
  const ratio = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const bgOf = (el: Element): RGBA => {
    const stack: RGBA[] = []
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor)
      if (c[3] > 0) stack.push(c)
      if (c[3] === 1) break
    }
    return stack.reverse().reduce((acc, c) => over(c, acc), [255, 255, 255, 1] as RGBA)
  }
  const out: { text: string; ratio: string; need: number; fg: string; bg: string }[] = []
  let min = 99, checked = 0
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? '').trim()
    const el = n.parentElement
    if (!text || !el || ['SCRIPT', 'STYLE'].includes(el.tagName) || el.closest('.edge-def')) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    const bg = bgOf(el)
    let fg = parse(cs.color); fg = over(fg, bg)
    const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight) >= 700
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5
    const r = ratio(fg, bg)
    checked++; min = Math.min(min, r)
    if (r < need) out.push({ text: text.slice(0, 40), ratio: r.toFixed(2), need, fg: cs.color, bg: `rgb(${bg.slice(0, 3).map(Math.round)})` })
  }
  return { bad: out, min: min.toFixed(2), checked }
}
