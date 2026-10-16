// In-process pub/sub for ServerEvents + the SSE endpoint.
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServerEvent } from '../shared/types';

export type Listener = (e: ServerEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  emit(e: ServerEvent) {
    for (const l of [...this.listeners]) {
      try { l(e); } catch { /* a broken listener must not break the server */ }
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  get size() { return this.listeners.size; }
}

export function sseHandler(bus: EventBus, pingMs = 15_000) {
  return (c: Context) => {
    const project = c.req.query('project') || null;
    return streamSSE(c, async (stream) => {
      const queue: ServerEvent[] = [];
      let wake: (() => void) | null = null;
      const unsub = bus.subscribe((e) => {
        // Global events (project_id '*') reach every subscriber, with or without ?project=.
        if (project && e.project_id !== project && e.project_id !== '*') return;
        queue.push(e);
        wake?.();
      });
      let closed = false;
      stream.onAbort(() => { closed = true; wake?.(); });
      const ping = setInterval(() => { if (!closed) stream.write(': ping\n\n').catch(() => { closed = true; wake?.(); }); }, pingMs);
      try {
        await stream.write(': connected\n\n');
        while (!closed) {
          while (queue.length && !closed) {
            const e = queue.shift()!;
            await stream.writeSSE({ data: JSON.stringify(e), event: undefined });
          }
          if (closed) break;
          await new Promise<void>((r) => { wake = r; });
          wake = null;
        }
      } catch { /* client went away */ } finally {
        clearInterval(ping);
        unsub();
      }
    });
  };
}
