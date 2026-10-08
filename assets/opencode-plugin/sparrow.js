// Sparrow plugin for OpenCode (loaded from OPENCODE_CONFIG_DIR/plugins/ by Sparrow-spawned agents).
// Inert unless SPARROW_AGENT_ID is set, so it never affects the user's own OpenCode sessions.
// Reports to the Sparrow server over HTTP:
//   - the root session id     → POST /api/hooks/session   {session_id}
//   - each root turn end      → POST /api/hooks/turn-end  {harness:'opencode', session_id, last_message}
// The server answers turn-end with {action:'none'} and types any follow-up into the TUI itself.

export const SparrowPlugin = async ({ client }) => {
  const agentId = process.env.SPARROW_AGENT_ID;
  if (!agentId) return {};
  // Guard against being loaded twice in one process (e.g. global + config-dir copies).
  const flag = Symbol.for('sparrow.opencode.plugin.' + agentId);
  if (globalThis[flag]) return {};
  globalThis[flag] = true;

  const url = (process.env.SPARROW_URL || 'http://127.0.0.1:4040').replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', 'x-sparrow-agent': agentId };
  if (process.env.SPARROW_CALL_ID) headers['x-sparrow-call'] = process.env.SPARROW_CALL_ID;

  const post = async (path, body) => {
    try {
      const res = await fetch(url + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      return await res.json().catch(() => null);
    } catch {
      return null;
    }
  };

  const parentOf = new Map(); // sessionID -> parentID|null
  const reported = new Set();

  const isRoot = async (sessionID) => {
    if (parentOf.has(sessionID)) return !parentOf.get(sessionID);
    try {
      const r = await client.session.get({ path: { id: sessionID } });
      const info = r?.data ?? r;
      parentOf.set(sessionID, info?.parentID ?? null);
      return !info?.parentID;
    } catch {
      return true;
    }
  };

  const reportSession = async (sessionID) => {
    if (!sessionID || reported.has(sessionID)) return;
    reported.add(sessionID);
    await post('/api/hooks/session', { session_id: sessionID });
  };

  const lastAssistantText = async (sessionID) => {
    try {
      const r = await client.session.messages({ path: { id: sessionID } });
      const list = r?.data ?? r ?? [];
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (m?.info?.role !== 'assistant') continue;
        const text = (m.parts ?? [])
          .filter((p) => p?.type === 'text' && p.text && !p.synthetic)
          .map((p) => p.text)
          .join('\n')
          .trim();
        if (text) return text.length > 4000 ? '…' + text.slice(-4000) : text;
      }
    } catch {}
    return undefined;
  };

  return {
    event: async ({ event }) => {
      try {
        if (event?.type === 'session.created') {
          const info = event.properties?.info;
          if (info?.id) {
            parentOf.set(info.id, info.parentID ?? null);
            if (!info.parentID) await reportSession(info.id);
          }
        } else if (event?.type === 'session.idle') {
          const sessionID = event.properties?.sessionID;
          if (!sessionID || !(await isRoot(sessionID))) return;
          await reportSession(sessionID);
          const last = await lastAssistantText(sessionID);
          await post('/api/hooks/turn-end', { harness: 'opencode', session_id: sessionID, last_message: last });
        }
      } catch {}
    },
  };
};

