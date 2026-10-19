import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SHORTCUT_GROUPS } from '@/lib/triage'

/** `?` on the board: every key, in groups. Keys pause while it is open (the board checks for an open dialog). */
export function ShortcutSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md" data-testid="shortcut-sheet">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Keys pause while you type in a field or a ticket is open. Every change has an Undo in its toast.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title} aria-label={g.title}>
              <h3 className="mb-1.5 text-[11px] font-medium text-zinc-400">{g.title}</h3>
              <dl className="grid grid-cols-[8.5rem_1fr] items-center gap-y-1.5 text-xs">
                {g.keys.map(([keys, what]) => (
                  <div key={keys} className="contents">
                    <dt><kbd className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-px font-mono text-[11px] whitespace-nowrap text-zinc-600">{keys}</kbd></dt>
                    <dd className="text-zinc-700">{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
