// Model-provider health (dogfood D2): classify "the provider answered with an error" from a turn-end payload or a
// screen, and count consecutive errors per harness + provider. N errors within M minutes with no success between
// them mark the pair `degraded` until a later success (an agent report or a clean turn end).
import type { HarnessName, ProviderHealth } from '../shared/types';

/** Provider = the model's prefix (`opencode-go/kimi-k3` → `opencode-go`), else the harness itself (its default provider). */
export function providerOf(harness: HarnessName | string, model: string | null | undefined): string {
  const m = (model ?? '').trim();
  const i = m.indexOf('/');
  return i > 0 ? m.slice(0, i) : String(harness);
}

// Match harness-shaped error lines, never keyword mentions in assistant prose. Provider hooks are already trusted
// harness reports; these patterns cover text the harness itself shows in a turn-end payload or screen capture.
const ERROR_LINE: RegExp[] = [
  /^\W{0,4}API Error:\s*(?:\d{3}(?:\s+(?:Internal Server Error|Too Many Requests|Bad Gateway|Service Unavailable|Gateway Timeout|overloaded_error))?|Connection error\.?)$/i, // Claude Code error screen/payload
  /^\W{0,4}Internal Server Error\s*\[retrying in \d+s attempt #\d+\]$/i, // OpenCode retry toast
  /^\W{0,4}Error:\s*Internal Server Error\.?$/i,
  /^\W{0,4}AI_APICallError(?:: Internal Server Error)?$/i, // OpenCode AI SDK error payload/toast
  /^\W{0,4}Error:\s*(?:This API key has expired(?:\. Create a new API key in OpenCode Console(?:…|\.)?)?|Invalid API key|Please run \/login|OAuth token has expired)(?:\.|$)$/i,
  /^\W{0,4}(?:you(?:'|’)ve|you have) hit your (?:usage |rate )?limit(?:\. Try again at \d{1,2}:\d{2} (?:AM|PM)\.?| · resets \d{1,2}:\d{2} (?:AM|PM))?$/i,
  /^\W{0,4}usage limit reached(?: · resets \d{1,2}:\d{2} (?:AM|PM))?$/i,
  /^\W{0,4}Rate limit exceeded(?:, retry later| · resets \d{1,2}:\d{2} (?:AM|PM))?\.?$/i,
  /^\W{0,4}429\s+Too Many Requests\.?$/i,
  /^\W{0,4}(?:overloaded_error|API is overloaded|Credit balance is too low)$/i,
  /^\W{0,4}stream disconnected before completion(?:: error sending request)?$/i,
  /^\W{0,4}exceeded retry limit\.?$/i,
  /^\W{0,4}unexpected status (?:4\d\d|5\d\d)(?:: (?:Invalid API key|API key has expired|Internal Server Error|Rate limit exceeded|overloaded_error|error sending request)| (?:Bad Request|Unauthorized|Payment Required|Forbidden|Not Found|Request Timeout|Conflict|Payload Too Large|Unprocessable Entity|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)(?:: (?:Invalid API key|API key has expired|Internal Server Error|Rate limit exceeded|overloaded_error|error sending request))?)?$/i, // Codex
];

// A JSON suffix is accepted only when the entire suffix parses as an object. JSON-looking prose is not an error payload.
const JSON_ERROR_LINE: RegExp[] = [
  /^\W{0,4}API Error:\s*\d{3}\s+(\{.*\})$/i,
  /^\W{0,4}Error:\s*Internal Server Error\s+(\{.*\})$/i,
  /^\W{0,4}AI_APICallError\s+(\{.*\})$/i,
  /^\W{0,4}429\s+Too Many Requests\s+(\{.*\})$/i,
  /^\W{0,4}(?:overloaded_error|API is overloaded|Credit balance is too low)\s+(\{.*\})$/i,
  /^\W{0,4}unexpected status (?:4\d\d|5\d\d)\s+(\{.*\})$/i,
];

function isProviderErrorLine(line: string): boolean {
  if (ERROR_LINE.some((re) => re.test(line))) return true;
  for (const re of JSON_ERROR_LINE) {
    const match = re.exec(line);
    if (!match) continue;
    try {
      const payload: unknown = JSON.parse(match[1]);
      if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) return true;
    } catch { /* not a JSON payload */ }
  }
  return false;
}

/** Last lines examined: error screens sit at the bottom; older scrollback is the agent's own output. */
const TAIL_LINES = 12;
/** A turn-end `last_message` longer than this is the agent's own prose, not a harness error line. */
const MAX_ERROR_MESSAGE = 600;

/** First line of the provider error found at the end of `text`, or null. */
export function classifyProviderError(text: string | null | undefined, kind: 'message' | 'screen' = 'message'): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t || (kind === 'message' && (t.length > MAX_ERROR_MESSAGE || /[\r\n]/.test(t)))) return null;
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean).slice(-TAIL_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isProviderErrorLine(lines[i])) return lines[i].replace(/\s+/g, ' ').slice(0, 200);
  }
  return null;
}

interface Entry { harness: HarnessName; provider: string; errors: number[]; last_error: string | null; last_error_at: number | null; last_ok_at: number | null; degraded_since: number | null }

export class ProviderTracker {
  private entries = new Map<string, Entry>();
  constructor(private threshold: () => number, private windowMs: () => number) {}

  private key = (harness: string, provider: string) => `${harness}\u0000${provider}`;

  private view(e: Entry): ProviderHealth {
    return {
      harness: e.harness, provider: e.provider, degraded: e.degraded_since != null, errors: e.errors.length, last_error: e.last_error,
      last_error_at: e.last_error_at, last_ok_at: e.last_ok_at, degraded_since: e.degraded_since,
    };
  }

  /** Record an error; returns the new state and whether it just became degraded. */
  error(harness: HarnessName, provider: string, message: string, now: number): { health: ProviderHealth; newlyDegraded: boolean } {
    const k = this.key(harness, provider);
    const e = this.entries.get(k) ?? { harness, provider, errors: [], last_error: null, last_error_at: null, last_ok_at: null, degraded_since: null };
    this.entries.set(k, e);
    e.errors = [...e.errors.filter((t) => t > now - this.windowMs()), now];
    e.last_error = message;
    e.last_error_at = now;
    const was = e.degraded_since != null;
    if (e.errors.length >= this.threshold() && !was) e.degraded_since = now;
    return { health: this.view(e), newlyDegraded: !was && e.degraded_since != null };
  }

  /** Record a success; returns the new state when it changed anything (recovered / cleared a streak), else null. */
  ok(harness: HarnessName, provider: string, now: number): { health: ProviderHealth; recovered: boolean } | null {
    const e = this.entries.get(this.key(harness, provider));
    if (!e) return null;
    e.last_ok_at = now;
    if (!e.errors.length && e.degraded_since == null) return null;
    const recovered = e.degraded_since != null;
    e.errors = [];
    e.degraded_since = null;
    return { health: this.view(e), recovered };
  }

  get(harness: string, provider: string): ProviderHealth | null {
    const e = this.entries.get(this.key(harness, provider));
    return e ? this.view(e) : null;
  }

  /** Every pair that has seen an error, degraded first. */
  list(): ProviderHealth[] {
    return [...this.entries.values()].map((e) => this.view(e))
      .sort((a, b) => Number(b.degraded) - Number(a.degraded) || (b.last_error_at ?? 0) - (a.last_error_at ?? 0));
  }
}
