import { Children, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { MentionText } from './bits'

// Light markdown for message bodies and card details: headings, lists, code, tables, links.
// Plain-text children get @mention highlighting.
function withMentions(children: ReactNode, handles?: Set<string>): ReactNode {
  return Children.map(children, (c) => (typeof c === 'string' ? <MentionText text={c} handles={handles} /> : c))
}

export function Markdown({ text, handles, className }: { text: string; handles?: Set<string>; className?: string }) {
  const components: Components = {
    p: ({ children }) => <p className="my-1.5 whitespace-pre-line first:mt-0 last:mb-0">{withMentions(children, handles)}</p>,
    li: ({ children }) => <li className="my-0.5 whitespace-pre-line">{withMentions(children, handles)}</li>,
    h1: ({ children }) => <h4 className="mt-3 mb-1 text-[1em] font-semibold first:mt-0">{children}</h4>,
    h2: ({ children }) => <h4 className="mt-3 mb-1 text-[1em] font-semibold first:mt-0">{children}</h4>,
    h3: ({ children }) => <h5 className="mt-2.5 mb-1 text-[1em] font-semibold first:mt-0">{children}</h5>,
    h4: ({ children }) => <h5 className="mt-2.5 mb-1 text-[1em] font-semibold first:mt-0">{children}</h5>,
    ul: ({ children }) => <ul className="my-1.5 list-disc pl-5 marker:text-muted-foreground/60">{children}</ul>,
    ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5 marker:text-muted-foreground">{children}</ol>,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-foreground underline decoration-muted-foreground/50 underline-offset-2 transition-colors hover:decoration-foreground">{children}</a>,
    blockquote: ({ children }) => <blockquote className="my-1.5 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
    pre: ({ children }) => (
      <pre className="my-2 overflow-x-auto rounded-lg bg-zinc-950 px-3.5 py-3 font-mono text-[12px] leading-relaxed text-zinc-100 ring-1 ring-border/60">
        {children}
      </pre>
    ),
    code: ({ className, children }) =>
      className?.startsWith('language-') || String(children).includes('\n') ? (
        <code className="font-mono">{children}</code>
      ) : (
        <code className="rounded bg-muted px-1 py-px font-mono text-[0.88em]">{children}</code>
      ),
    table: ({ children }) => <div className="my-2 overflow-x-auto"><table className="w-full text-[0.92em]">{children}</table></div>,
    th: ({ children }) => <th className="border-b border-border px-2.5 py-1.5 text-left font-medium text-muted-foreground">{children}</th>,
    td: ({ children }) => <td className="border-b border-border/60 px-2.5 py-1.5">{children}</td>,
    hr: () => <hr className="my-3 border-border" />,
  }
  return (
    <div className={cn('text-[13px] leading-relaxed break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  )
}
