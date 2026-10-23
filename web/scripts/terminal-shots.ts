#!/usr/bin/env bun
// docs/images/terminal-crew.png: real Claude Code / Codex / OpenCode panes from one Sparrow server, plus the captain's
// `sparrow inbox`, rendered from saved `tmux capture-pane -e -p` text in a clean frame.
//
//   bun scripts/terminal-shots.ts                       # render from scripts/terminal-fixtures/*.ans + inbox.txt
//   bun scripts/terminal-shots.ts --redact <rawdir>     # raw captures (maya.ans leo.ans juno.ans inbox.txt) -> fixtures
//
// How the captures were made (spends a little real usage on cheap models; do it once):
//   bun bin/sparrow sandbox up --dir $TMP/sbx                       # own home, free port, own tmux socket
//   put three resumes in $TMP/sbx/home/resumes: claude haiku low, codex gpt-6-luna low, opencode a *-free model
//   (cd $REPO && $TMP/sbx/sbx hire <resume> "<task>" --name maya --cwd $REPO)   # one per harness, in a throwaway git repo
//   while they work: tmux -L <socket> resize-window -t <session>:<handle> -x 100 -y 34, then
//                    tmux -L <socket> capture-pane -e -p -t <session>:<handle>  (the files are the .ans inputs)
//   $TMP/sbx/sbx inbox > inbox.txt                                   # the captain's view of the results
//   bun bin/sparrow sandbox down --dir $TMP/sbx
// `--redact` strips what must not ship: account / plan / usage-limit lines, hook noise from the maker's own settings,
// OSC-8 links, home and temp paths, session ids. It prints anything suspicious left over and exits 1.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import puppeteer from 'puppeteer-core'
import { chromeExecutable } from './browser'

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { redact: { type: 'string' }, out: { type: 'string' } } })
const WEB = resolve(import.meta.dir, '..')
const FIX = join(import.meta.dir, 'terminal-fixtures')
const OUT = resolve(values.out ?? join(WEB, '..', 'docs', 'images', 'terminal-crew.png'))
const MAX_BYTES = 450 * 1024

// ---------------------------------------------------------------- redaction
const DROP_LINE = /login expires|run \/login|5h limit|weekly limit|usage limit|Heads up, you have|warnings? ·|aws-mcp|MCP error|credentials|rtk|PreToolUse|non-blocking status|Claude (Max|Pro|Team|Enterprise)|ChatGPT (Plus|Pro|Team)|@[\w-]+\.(com|org|io)/i
const OSC8 = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g
const SUSPECT = /\/Users\/|\/home\/(?!demo)|\/private\/|\/tmp\/|claude-501|scratchpad|@[\w-]+\.(?:com|org|io)|\b(?:Max|Pro|Plus|Enterprise) (?:plan|account)\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ses_[A-Za-z0-9]{10,}/

export function redact(raw: string, repoDir: string): string {
  const esc = repoDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const name = repoDir.split('/').pop()!
  return raw
    .replace(OSC8, '')
    .split('\n')
    .filter((l) => !DROP_LINE.test(l.replace(/\x1b\[[0-9;:]*m/g, '')))
    .join('\n')
    .replace(new RegExp(esc, 'g'), '~/code/tortuga')
    .replace(new RegExp(name, 'gi'), 'tortuga')
    .replace(/(?:\/private)?\/tmp\/\S*/g, '~/code/tortuga')
}

if (values.redact) {
  const raw = resolve(values.redact)
  const repo = readFileSync(join(raw, 'repo.path'), 'utf8').trim()
  mkdirSync(FIX, { recursive: true })
  let bad = 0
  for (const f of ['maya.ans', 'leo.ans', 'juno.ans', 'inbox.txt']) {
    const text = redact(readFileSync(join(raw, f), 'utf8'), repo)
    writeFileSync(join(FIX, f), text)
    for (const [i, l] of text.replace(/\x1b\[[0-9;:]*m/g, '').split('\n').entries()) {
      if (SUSPECT.test(l)) { bad++; console.error(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`) }
    }
  }
  console.error(bad ? `${bad} suspicious line(s) left: fix the redaction before committing the fixtures` : 'fixtures written, nothing suspicious left')
  process.exit(bad ? 1 : 0)
}

// ---------------------------------------------------------------- ANSI -> HTML
const BASE16 = ['#1d1f27', '#e06c75', '#7ec699', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#c8ccd4', '#5c6370', '#ff8b94', '#98e6b3', '#f0d08a', '#7cc4ff', '#dc8cf0', '#7ad6e3', '#ffffff']
const FG = '#d6d9e0'
const BG = '#14161c'
function color256(n: number): string {
  if (n < 16) return BASE16[n]
  if (n < 232) { const c = n - 16; const v = (x: number) => (x === 0 ? 0 : 55 + x * 40); return `rgb(${v(Math.floor(c / 36))},${v(Math.floor(c / 6) % 6)},${v(c % 6)})` }
  const g = 8 + (n - 232) * 10
  return `rgb(${g},${g},${g})`
}
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

interface St { fg: string | null; bg: string | null; bold: boolean; dim: boolean; italic: boolean; underline: boolean; inverse: boolean }
const fresh = (): St => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false })

function applySgr(st: St, params: number[]) {
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) Object.assign(st, fresh())
    else if (p === 1) st.bold = true
    else if (p === 2) st.dim = true
    else if (p === 3) st.italic = true
    else if (p === 4) st.underline = true
    else if (p === 7) st.inverse = true
    else if (p === 22) { st.bold = false; st.dim = false }
    else if (p === 23) st.italic = false
    else if (p === 24) st.underline = false
    else if (p === 27) st.inverse = false
    else if (p >= 30 && p <= 37) st.fg = BASE16[p - 30]
    else if (p >= 90 && p <= 97) st.fg = BASE16[p - 90 + 8]
    else if (p >= 40 && p <= 47) st.bg = BASE16[p - 40]
    else if (p >= 100 && p <= 107) st.bg = BASE16[p - 100 + 8]
    else if (p === 39) st.fg = null
    else if (p === 49) st.bg = null
    else if (p === 38 || p === 48) {
      const key = p === 38 ? 'fg' : 'bg'
      if (params[i + 1] === 5) { st[key] = color256(params[i + 2] ?? 0); i += 2 }
      else if (params[i + 1] === 2) { st[key] = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`; i += 4 }
    }
  }
}

/** One captured screen (tmux capture-pane -e -p) as HTML lines. */
export function ansiToHtml(text: string): string[] {
  const st = fresh()
  const out: string[] = []
  for (const line of text.replace(/\r/g, '').split('\n')) {
    let html = ''
    let last = 0
    const re = /\x1b\[([0-9;:]*)m/g
    const push = (s: string) => {
      if (!s) return
      let fg = st.fg, bg = st.bg
      if (st.inverse) [fg, bg] = [bg ?? BG, fg ?? FG]
      const css = [fg ? `color:${fg}` : '', bg ? `background:${bg}` : '', st.bold ? 'font-weight:700' : '', st.dim ? 'opacity:.6' : '', st.italic ? 'font-style:italic' : '', st.underline ? 'text-decoration:underline' : ''].filter(Boolean).join(';')
      html += css ? `<span style="${css}">${escHtml(s)}</span>` : escHtml(s)
    }
    for (let m = re.exec(line); m; m = re.exec(line)) {
      push(line.slice(last, m.index))
      applySgr(st, m[1].split(/[;:]/).map((x) => Number(x || 0)))
      last = m.index + m[0].length
    }
    push(line.slice(last))
    out.push(html)
  }
  return out
}

// ---------------------------------------------------------------- the frame
const ROWS = 34
const trimTail = (lines: string[]) => { const a = [...lines]; while (a.length && !a.at(-1)!.replace(/<[^>]+>/g, '').trim()) a.pop(); return a }

function pane(title: string, sub: string, dot: string, html: string[], cls = ''): string {
  const rows = trimTail(html).slice(-ROWS)
  return `<section class="win ${cls}"><header><i style="background:${dot}"></i><b>${title}</b><span>${sub}</span></header><pre>${rows.join('\n')}</pre></section>`
}

function inboxHtml(text: string): string[] {
  return text.replace(/\r/g, '').split('\n').map((l) => {
    const e = escHtml(l)
    if (l.startsWith('$ ')) return `<span style="color:#7ec699">$</span> ${escHtml(l.slice(2))}`
    if (l.startsWith('━━')) return `<span style="color:#e5c07b;font-weight:700">${e}</span>`
    if (l.startsWith('──')) return `<span style="color:#7cc4ff;font-weight:700">${e}</span>`
    if (/^\s+\d\d:\d\d:\d\d\s+update/.test(l)) return `<span style="opacity:.6">${e}</span>`
    if (/^\s+## /.test(l)) return `<span style="color:#7ec699;font-weight:700">${e}</span>`
    return e
  })
}

const read = (f: string) => { const p = join(FIX, f); if (!existsSync(p)) throw new Error(`missing ${p}: run with --redact <rawdir> first`); return readFileSync(p, 'utf8') }
const css = `
  *{box-sizing:border-box} body{margin:0;background:#eceae6;font:13px -apple-system,'Segoe UI',system-ui,sans-serif}
  main{width:1440px;padding:28px;display:grid;grid-template-columns:1fr 1fr;gap:22px}
  .win{background:${BG};border-radius:12px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.18),0 10px 28px rgba(0,0,0,.16);min-width:0}
  .win header{display:flex;align-items:center;gap:9px;padding:9px 14px;background:#232733;color:#e8eaf0;border-bottom:1px solid #2f3442}
  .win header i{width:9px;height:9px;border-radius:50%} .win header b{font-size:13px} .win header span{color:#98a0b3;font-size:12px}
  .win pre{margin:0;padding:12px 14px;color:${FG};font:10.6px/1.34 'SF Mono',ui-monospace,Menlo,Consolas,monospace;height:calc(${ROWS} * 1.34 * 10.6px + 24px);overflow:hidden;white-space:pre;tab-size:4}
  .win.wrap pre{white-space:pre-wrap;word-break:break-word}`

const html = `<!doctype html><meta charset="utf-8"><style>${css}</style><main>
${pane('@maya', 'Claude Code · haiku · builder', '#e8825a', ansiToHtml(read('maya.ans')))}
${pane('@leo', 'Codex · gpt-6-luna · verifier', '#4aa3ff', ansiToHtml(read('leo.ans')))}
${pane('@juno', 'OpenCode · glm-5.3 flash · researcher', '#3ecf8e', ansiToHtml(read('juno.ans')))}
${pane('@captain', 'sparrow inbox', '#e5c07b', inboxHtml(read('inbox.txt')), 'wrap')}
</main>`

const browser = await puppeteer.launch({ executablePath: chromeExecutable(), args: ['--no-sandbox'], headless: true })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  await page.setContent(html, { waitUntil: 'load' })
  const box = await page.$eval('main', (m) => { const r = m.getBoundingClientRect(); return { w: Math.ceil(r.width), h: Math.ceil(r.height) } })
  mkdirSync(resolve(OUT, '..'), { recursive: true })
  await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: box.w, height: box.h } })
} finally { await browser.close() }
for (const q of ['70-90', '55-80', '40-65']) {
  Bun.spawnSync(['pngquant', '--quality', q, '--speed', '1', '--strip', '--force', '--output', OUT, OUT])
  Bun.spawnSync(['oxipng', '-o', '4', '--strip', 'safe', '--quiet', OUT])
  if (statSync(OUT).size <= MAX_BYTES) break
}
console.error(`${OUT}  ${(statSync(OUT).size / 1024).toFixed(0)} KB`)
if (statSync(OUT).size > MAX_BYTES) process.exit(1)
