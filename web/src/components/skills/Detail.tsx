import { useEffect, useState } from 'react'
import { ArrowLeft, File, Folder, GitCommitHorizontal, Link2, Lock, TriangleAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { agoLabel } from '@/lib/format'
import {
  HARNESS_NAME, ROOT_LABEL, fileSize, flattenTree, skillsHref, splitFrontmatter, tilde,
  type SkillDetail, type SkillEntry,
} from '@/lib/skills'
import { useStore } from '@/lib/store'
import { Empty } from '@/components/sparrow/bits'
import { Markdown } from '@/components/sparrow/Markdown'
import { setHarness } from '@/lib/skillActions'
import { HarnessCell, Pill, SourceBadge, Tilde } from './bits'

function Panel({ title, count, children, testid }: { title: string; count?: number; children: React.ReactNode; testid?: string }) {
  return (
    <section className="overflow-hidden rounded-xl border bg-background" data-testid={testid}>
      <h2 className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}{count !== undefined && <span className="font-normal normal-case">{count}</span>}
      </h2>
      {children}
    </section>
  )
}

const STATUS_TONE: Record<SkillEntry['status'], 'ok' | 'warn' | 'bad' | 'none'> = {
  managed: 'ok', sparrow: 'none', external: 'none', unmanaged: 'warn', conflict: 'bad', broken: 'bad',
}

export function SkillDetailPage({ name, home }: { name: string; home: string }) {
  const rev = useStore((s) => s.skillsRev)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.skill(name).then(
      (d) => { if (live) { setDetail(d); setError(null) } },
      (e: Error & { status?: number }) => { if (live) setError({ status: e.status ?? 0, message: e.message }) },
    )
    return () => { live = false }
  }, [name, rev])

  const back = (
    <a href={skillsHref()} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" /> Skills</a>
  )
  if (error) {
    return (
      <div className="h-full overflow-y-auto"><div className="mx-auto max-w-6xl px-4 py-4">
        {back}
        <Empty title={error.status === 404 ? `No skill named "${name}"` : 'Could not load the skill'} className="mt-6">{error.message}</Empty>
      </div></div>
    )
  }
  if (!detail) return <div className="p-4 text-xs text-muted-foreground">{back}<div className="mt-3">Loading…</div></div>

  const { skill, skill_md, files, log, entries } = detail
  const { front, body } = splitFrontmatter(skill_md)
  const rows = flattenTree(files)
  const problems = skill.problems.filter((p) => p.code !== 'not-in-manifest')

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4">
        {back}
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {skill.locked && <Lock className="size-4 text-muted-foreground" />}
              <h1 className="text-base font-semibold" data-testid="skill-title">{skill.name}</h1>
              <SourceBadge skill={skill} />
              {skill.locked && <Pill>locked · built into Sparrow</Pill>}
              {!skill.inManifest && <Pill tone="warn">not in manifest</Pill>}
            </div>
            <p className="mt-1 max-w-3xl text-[13px] text-muted-foreground">{skill.description ?? 'No description.'}</p>
            <div className="mt-1 text-xs text-muted-foreground">Folder <Tilde path={skill.path} home={home} max={70} /></div>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-xl border bg-background px-3 py-2" data-testid="detail-toggles">
            {skill.links.map((link) => (
              <div key={link.harness} className="space-y-1">
                <div className="text-[11px] tracking-wide text-muted-foreground uppercase">{HARNESS_NAME[link.harness]}</div>
                <HarnessCell
                  skill={skill} link={link} busy={busy === link.harness}
                  onToggle={() => { setBusy(link.harness); void setHarness(skill, link.harness).finally(() => setBusy(null)) }}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Panel title="SKILL.md" testid="skill-md">
            <div className="px-4 py-3 text-[13px] leading-relaxed">
              {front && (
                <pre className="mb-3 overflow-x-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-[11.5px] text-muted-foreground">{front}</pre>
              )}
              {body.trim() ? <Markdown text={body} /> : <span className="text-muted-foreground">SKILL.md has no body.</span>}
            </div>
          </Panel>

          <div className="flex min-w-0 flex-col gap-4">
            {problems.length > 0 && (
              <Panel title="Spec problems" count={problems.length} testid="problems">
                <ul className="space-y-1 px-3 py-2 text-xs">
                  {problems.map((p, i) => (
                    <li key={i} className="flex gap-1.5"><TriangleAlert className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400" /><span><span className="font-mono text-muted-foreground">{p.code}</span> {p.message}</span></li>
                  ))}
                </ul>
              </Panel>
            )}

            <Panel title="Where it is linked" count={entries.length} testid="entries">
              <ul className="divide-y text-xs">
                {entries.map((e) => (
                  <li key={e.path} className="flex items-center gap-2 px-3 py-1.5" data-entry={`${e.root}/${e.name}`}>
                    <span className="w-24 shrink-0 text-muted-foreground">{e.root === 'library' ? 'library' : (HARNESS_NAME[e.root as keyof typeof HARNESS_NAME] ?? ROOT_LABEL[e.root])}</span>
                    <span className="min-w-0 flex-1">
                      <Tilde path={e.path.slice(0, e.path.lastIndexOf('/'))} home={home} max={40} className="block truncate" />
                      {e.kind === 'link' && <span className="flex items-center gap-1 text-muted-foreground"><Link2 className="size-3" /> {e.linkTarget ? tilde(e.linkTarget, home) : '?'}</span>}
                    </span>
                    <Pill tone={STATUS_TONE[e.status]}>{e.status}</Pill>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="Files" count={rows.length} testid="files">
              <ul className="max-h-72 overflow-y-auto py-1 font-mono text-[11.5px]">
                {rows.map(({ node, depth }) => (
                  <li key={node.path} className="flex items-center gap-1.5 px-3 py-0.5" style={{ paddingLeft: 12 + depth * 14 }}>
                    {node.type === 'dir' ? <Folder className="size-3.5 shrink-0 text-muted-foreground" /> : node.type === 'link' ? <Link2 className="size-3.5 shrink-0 text-muted-foreground" /> : <File className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    <span className="shrink-0 text-muted-foreground">{fileSize(node.size)}</span>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="History" count={log.length} testid="history">
              {log.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">{skill.locked ? 'Ships with Sparrow: versioned in the Sparrow repo.' : 'No commits touch this folder yet.'}</div>
              ) : (
                <ul className="max-h-72 divide-y overflow-y-auto text-xs">
                  {log.map((c) => (
                    <li key={c.hash} className="flex items-start gap-2 px-3 py-1.5">
                      <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1"><div className="truncate">{c.subject}</div><div className="text-muted-foreground">{c.author} · {agoLabel(Date.parse(c.date))}</div></div>
                      <span className="font-mono text-muted-foreground">{c.shortHash}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      </div>
    </div>
  )
}
