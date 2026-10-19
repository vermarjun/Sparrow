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
    p: ({ children }) => <p className="my-1 whitespace-pre-line first:mt-0 last:mb-0">{withMentions(children, handles)}</p>,
    li: ({ children }) => <li className="my-0.5 whitespace-pre-line">{withMentions(children, handles)}</li>,
    h1: ({ children }) => <h4 className="mt-2 mb-1 text-[13px] font-semibold first:mt-0">{children}</h4>,
    h2: ({ children }) => <h4 className="mt-2 mb-1 text-[13px] font-semibold first:mt-0">{children}</h4>,
    h3: ({ children }) => <h5 className="mt-2 mb-1 text-[13px] font-semibold first:mt-0">{children}</h5>,
    h4: ({ children }) => <h5 className="mt-2 mb-1 text-[13px] font-semibold first:mt-0">{children}</h5>,
    ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="text-blue-700 underline dark:text-blue-400 underline-offset-2">{children}</a>,
    blockquote: ({ children }) => <blockquote className="my-1 border-l-2 border-zinc-300 pl-2 text-zinc-600 dark:border-zinc-600 dark:text-zinc-400">{children}</blockquote>,
    pre: ({ children }) => (
      <pre className="my-1.5 overflow-x-auto rounded-md bg-zinc-900 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-zinc-100">
        {children}
      </pre>
    ),
    code: ({ className, children }) =>
      className?.startsWith('language-') || String(children).includes('\n') ? (
        <code className="font-mono">{children}</code>
      ) : (
        <code className="rounded bg-black/[0.06] dark:bg-white/10 px-1 py-px font-mono text-[0.9em]">{children}</code>
      ),
    table: ({ children }) => <div className="my-1.5 overflow-x-auto"><table className="text-xs">{children}</table></div>,
    th: ({ children }) => <th className="border-b px-2 py-1 text-left font-semibold">{children}</th>,
    td: ({ children }) => <td className="border-b border-zinc-100 dark:border-zinc-800 px-2 py-1">{children}</td>,
    hr: () => <hr className="my-2 border-zinc-200 dark:border-zinc-700" />,
  }
  return (
    <div className={cn('text-[13px] leading-relaxed break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  )
}
