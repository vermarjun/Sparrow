# README diagrams

Sources are plain HTML + inline SVG in `src/<name>.html`, styled by one shared `src/diagram.css` (tokens for light and dark) and laid out by `src/diagram.js` (icons, auto-routed arrows and labels). Nothing loads from the network: fonts are Geist and Geist Mono (`fonts/`, SIL OFL) and icons are Lucide (ISC) inlined from `src/icons.js`.

- **Edit**: open `src/<name>.html?theme=dark` (or without the query for light) in a browser. Arrows are declared at the bottom of each page as `<b class="edge-def" data-from="#a" data-to="#b" …>`; see the header of `src/diagram.js` for the options.
- **Render**: `bun docs/diagrams/render.ts [name …]` writes `docs/images/<name>-light.png` and `-dark.png` (1280 CSS px, 2x), fails on any text under WCAG AA contrast, then compresses with `pngquant` + `oxipng` (`brew install pngquant oxipng`; skipped with a warning when missing). Needs Google Chrome (`CHROME_BIN` to override) and `web/node_modules`.
- **Icons**: add a Lucide name to `gen-icons.ts` and run `bun docs/diagrams/gen-icons.ts`.
- **Embed** (README): `<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/x-dark.png"><img src="docs/images/x-light.png" alt="…"></picture>`; `preview.html` shows them all (git-ignored).
