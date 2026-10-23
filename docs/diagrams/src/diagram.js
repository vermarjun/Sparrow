// Shared runtime for the diagram pages: theme switch, icon hydration, auto-routed edges.
// Edges are declared in markup, e.g.
//   <b class="edge-def" data-from="#a" data-to="#b" data-fs="r" data-ts="l" data-label="sparrow hire" data-tone="accent"></b>
// data-fs / data-ts: side of the box (t r b l); data-fy / data-ty: position along that side (0..1, default .5); data-fp / data-tp: the same in px from the top/left;
// data-mx / data-my: frame-relative coordinate of the middle segment (data-moff: px offset from the default middle); data-both: arrowhead on both ends; data-dashed;
// data-label (+ data-lt = .5 along the longest segment, data-lx / data-ly nudge, data-lclass = text|accent|boxed).
(function () {
  const q = new URLSearchParams(location.search)
  const theme = q.get('theme') === 'dark' ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme

  function hydrateIcons() {
    document.querySelectorAll('i.ic[data-i]').forEach((el) => {
      const inner = window.ICONS[el.dataset.i]
      if (!inner) throw new Error('unknown icon ' + el.dataset.i)
      el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`
    })
  }

  const NS = 'http://www.w3.org/2000/svg'
  const R = 14

  function port(frame, sel, side, f, px) {
    const el = frame.querySelector(sel)
    if (!el) throw new Error('edge target not found: ' + sel)
    const fr = frame.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const x = r.left - fr.left, y = r.top - fr.top
    const oy = px !== undefined ? px : r.height * f, ox = px !== undefined ? px : r.width * f
    if (side === 'l') return { x, y: y + oy }
    if (side === 'r') return { x: x + r.width, y: y + oy }
    if (side === 't') return { x: x + ox, y }
    return { x: x + ox, y: y + r.height }
  }

  function route(a, b, fs, ts, mx, my, moff = 0) {
    const pts = [[a.x, a.y]]
    const horiz = (s) => s === 'l' || s === 'r'
    if (horiz(fs) && horiz(ts)) {
      const m = mx ?? (a.x + b.x) / 2
      if (a.y !== b.y) pts.push([m, a.y], [m, b.y])
    } else if (!horiz(fs) && !horiz(ts)) {
      const m = my ?? (a.y + b.y) / 2 + moff
      if (a.x !== b.x) pts.push([a.x, m], [b.x, m])
    } else if (horiz(fs)) pts.push([b.x, a.y])
    else pts.push([a.x, b.y])
    pts.push([b.x, b.y])
    return pts
  }

  function rounded(pts) {
    let d = `M${pts[0][0]} ${pts[0][1]}`
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1]
      const l1 = Math.hypot(cx - px, cy - py), l2 = Math.hypot(nx - cx, ny - cy)
      const r = Math.min(R, l1 / 2, l2 / 2)
      const ax = cx - ((cx - px) / l1) * r, ay = cy - ((cy - py) / l1) * r
      const bx = cx + ((nx - cx) / l2) * r, by = cy + ((ny - cy) / l2) * r
      d += ` L${ax} ${ay} Q${cx} ${cy} ${bx} ${by}`
    }
    const e = pts[pts.length - 1]
    return d + ` L${e[0]} ${e[1]}`
  }

  function head(tip, dir, size = 10) {
    const [dx, dy] = dir
    const bx = tip[0] - dx * size, by = tip[1] - dy * size
    const nx = -dy * (size * 0.55), ny = dx * (size * 0.55)
    return `M${tip[0]} ${tip[1]} L${bx + nx} ${by + ny} L${bx - nx} ${by - ny} Z`
  }

  function drawEdges() {
    const frame = document.querySelector('.frame')
    const fr = frame.getBoundingClientRect()
    frame.querySelectorAll('svg.edges, .elabels').forEach((n) => n.remove())
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('class', 'edges e')
    svg.setAttribute('width', fr.width); svg.setAttribute('height', fr.height)
    const labels = document.createElement('div'); labels.className = 'elabels'
    frame.prepend(svg); frame.append(labels)

    frame.querySelectorAll('.edge-def').forEach((el) => {
      const ds = el.dataset
      const fs = ds.fs, ts = ds.ts
      const a = port(frame, ds.from, fs, parseFloat(ds.fy ?? '.5'), ds.fp ? +ds.fp : undefined)
      const b = port(frame, ds.to, ts, parseFloat(ds.ty ?? '.5'), ds.tp ? +ds.tp : undefined)
      const pts = route(a, b, fs, ts, ds.mx ? +ds.mx : undefined, ds.my ? +ds.my : undefined, ds.moff ? +ds.moff : 0)
      const tone = ds.tone ? ' ' + ds.tone : ''
      const p = document.createElementNS(NS, 'path')
      p.setAttribute('d', rounded(pts)); p.setAttribute('class', 'line' + tone + (ds.dashed !== undefined ? ' dashed' : ''))
      svg.append(p)
      const h = (tip, dir) => {
        const hp = document.createElementNS(NS, 'path')
        hp.setAttribute('d', head(tip, dir)); hp.setAttribute('class', 'head' + tone); svg.append(hp)
      }
      const dirOf = (from, to) => { const l = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1; return [(to[0] - from[0]) / l, (to[1] - from[1]) / l] }
      const n = pts.length
      if (ds.nohead === undefined) h(pts[n - 1], dirOf(pts[n - 2], pts[n - 1]))
      if (ds.both !== undefined) h(pts[0], dirOf(pts[1], pts[0]))
      if (ds.label) {
        // longest segment midpoint
        let best = 0, bi = 0
        for (let i = 0; i < n - 1; i++) { const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); if (l > best) { best = l; bi = i } }
        const t = parseFloat(ds.lt ?? '.5')
        const x = pts[bi][0] + (pts[bi + 1][0] - pts[bi][0]) * t + parseFloat(ds.lx ?? '0')
        const y = pts[bi][1] + (pts[bi + 1][1] - pts[bi][1]) * t + parseFloat(ds.ly ?? '0')
        const lab = document.createElement('div')
        lab.className = 'elabel ' + (ds.lclass ?? '')
        lab.style.left = x + 'px'; lab.style.top = y + 'px'
        lab.innerHTML = ds.label
        labels.append(lab)
      }
    })
  }

  async function init() {
    hydrateIcons()
    await document.fonts.ready
    await Promise.all(['500 15px Geist', '650 20px Geist', '500 15px "Geist Mono"', '600 14px "Geist Mono"'].map((f) => document.fonts.load(f)))
    drawEdges()
    window.__ready = true
  }
  window.addEventListener('DOMContentLoaded', init)
})()
