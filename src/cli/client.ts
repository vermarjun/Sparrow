// Tiny HTTP client used by the CLI and by hooks. Identity comes from the environment:
// SPARROW_AGENT_ID / SPARROW_CALL_ID are set by the launch script inside agent windows.
import { SERVER_URL } from '../shared/config';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface ApiOpts {
  agentId?: string | null;   // overrides SPARROW_AGENT_ID (captain mode passes its registered id)
  timeoutMs?: number;        // default 30s; inbox long-poll passes more
  retries?: number;          // connection retries when the server is down (default 3, backoff 1s/2s/4s)
}

/**
 * Agent mode (SPARROW_AGENT_ID set) reports to the server that spawned the window (SPARROW_AGENT_URL, exported by the
 * launch script), whatever SPARROW_PORT/SPARROW_HOME/SPARROW_URL were later changed to (D19). Additive: no
 * SPARROW_AGENT_URL, or a different identity than the env's (captain registration passes agentId: null), uses SERVER_URL.
 */
export function baseUrl(agentId?: string | null): string {
  const env = process.env;
  const agentMode = !!env.SPARROW_AGENT_ID && !!env.SPARROW_AGENT_URL && (agentId === undefined || agentId === env.SPARROW_AGENT_ID);
  return agentMode ? env.SPARROW_AGENT_URL! : SERVER_URL;
}

export async function api<T = any>(method: string, path: string, body?: unknown, opts: ApiOpts = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const agentId = opts.agentId ?? process.env.SPARROW_AGENT_ID;
  if (agentId) headers['x-sparrow-agent'] = agentId;
  if (process.env.SPARROW_CALL_ID) headers['x-sparrow-call'] = process.env.SPARROW_CALL_ID;

  const retries = opts.retries ?? 3;
  const base = baseUrl(opts.agentId);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        // Bun's fetch has its own 300 s cap; long-polls (inbox --wait 600) need it off. Our signal still applies.
        timeout: false,
      } as RequestInit);
    } catch (err) {
      // Retry only when the server could not be reached. A timeout means the request may
      // already have been applied, and retrying a POST would duplicate it.
      const timedOut = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
      if (timedOut) {
        const secs = (opts.timeoutMs ?? 30_000) / 1000;
        throw new ApiError(0, method === 'GET'
          ? `Sparrow server did not answer ${method} ${path} within ${secs}s`
          : `Sparrow server did not answer ${method} ${path} within ${secs}s; it may still have been applied — check with: sparrow log`);
      }
      if (attempt < retries) {
        await Bun.sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new ApiError(0, `Sparrow server unreachable at ${base} (${(err as Error).message}). Start it with: sparrow up`);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
    return data as T;
  }
}
