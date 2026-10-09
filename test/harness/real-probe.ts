// Exploratory driver for real harness checks (used while building the matrix; not a test).
//   SPARROW_HOME=… bun test/harness/real-probe.ts <claude|codex|opencode> [model] [effort]
// Starts the stub on 4125, spawns the agent in a fresh temp cwd on tmux socket sparrow-test-t2, and keeps a
// control file the operator can drive: write a command line into $SPARROW_HOME/probe.cmd:
//   deliver <text with \n escapes> | kill | resume <prompt> | capture | quit | policy <allow|block:<reason>|none>
import { mkdtempSync, realpathSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SPARROW_TMUX_SOCKET ??= 'sparrow-test-t2';
process.env.SPARROW_HOME ??= realpathSync(mkdtempSync(join(tmpdir(), 'sparrow-probe-')));
const { startStub } = await import('./stub-server');
const { createSpawner } = await import('../../src/harness/spawner');
const tmux = await import('../../src/harness/tmux');

const [harness, model, effort] = process.argv.slice(2);
const port = Number(process.env.PROBE_PORT ?? 4125);
let policy = 'allow';
const stub = startStub(port, (req, rec, n) => {
  log(`TURN-END #${n} ${JSON.stringify(req).slice(0, 300)}`);
  if (policy.startsWith('block:')) {
    const reason = policy.slice(6);
    if (req.stop_hook_active) return { action: 'allow' };
    policy = 'allow';
    return { action: 'block', reason };
  }
  return { action: policy as any };
});
process.env.SPARROW_URL = stub.url;
const home = process.env.SPARROW_HOME!;
const cwd = realpathSync(mkdtempSync(join(tmpdir(), `sparrow-${harness}-cwd-`)));
const code = 'ZEBRA-' + Math.floor(Math.random() * 1e6);
const spawner = createSpawner();
const agent: any = {
  id: 'ag_probe' + Date.now().toString(36), project_id: 'probe', handle: 'probe', kind: 'agent', resume: harness, title: 'Probe',
  harness, model: model || null, effort: effort || null, can_hire: [], parent_id: null, depth: 1, cwd,
  tmux_session: 'sptest-probe', tmux_window: harness, tmux_window_id: null, session_id: null, state: 'working',
  call_id: null, last_end_reason: null, last_update: null, last_update_at: null, last_seen_at: null, created_at: 0, updated_at: 0,
};
const t0 = Date.now();
function log(s: string) {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`;
  console.log(line);
}
const system = `You are a Sparrow test agent (agent id ${agent.id}). Your secret codeword is ${code}. It appears only here.\nYou have a shell tool. The \`sparrow\` command is on PATH. Keep replies to one short sentence. Never ask questions.` + (process.env.PROBE_SYSTEM_EXTRA ? '\n' + process.env.PROBE_SYSTEM_EXTRA : '');
const prompt = process.env.PROBE_PROMPT ??
  'Run this shell command now, substituting your secret codeword from your system instructions: sparrow update "codeword=<codeword> agent=$SPARROW_AGENT_ID". Also remember the word "pelican" for later. Then reply "ok" and end your turn. Do not run sparrow done.';
let call = 1;
const r = await spawner.start({ agent, call_id: `call_p${call}`, system_prompt: system, prompt, resume: false });
agent.tmux_window_id = r.window_id;
agent.session_id = r.session_id;
log(`started window ${r.window_id} session ${r.session_id} cwd ${cwd} home ${home} code ${code}`);
writeFileSync(join(home, 'probe.agent.json'), JSON.stringify(agent));

let seen = 0;
const cmdFile = join(home, 'probe.cmd');
writeFileSync(cmdFile, '');
while (true) {
  await Bun.sleep(500);
  while (seen < stub.records.length) {
    const x = stub.records[seen++];
    const sid = x.body?.session_id;
    if (sid && !agent.session_id) { agent.session_id = sid; log(`learned session ${sid}`); }
    if (x.path !== '/api/hooks/turn-end') log(`REQ ${x.path} call=${x.call} ${JSON.stringify(x.body).slice(0, 300)}`);
  }
  const c = existsSync(cmdFile) ? readFileSync(cmdFile, 'utf8').trim() : '';
  if (!c) continue;
  writeFileSync(cmdFile, '');
  const [verb, ...rest] = c.split(' ');
  const arg = rest.join(' ').replace(/\\n/g, '\n');
  try {
    if (verb === 'deliver') { await spawner.deliver(agent, arg); log('delivered'); }
    else if (verb === 'kill') { await spawner.stop(agent); log(`killed; alive=${await spawner.isAlive(agent)}`); }
    else if (verb === 'resume') {
      call++;
      const sid = agent.session_id ?? (await spawner.discoverSession(agent, t0));
      agent.session_id = sid;
      const rr = await spawner.start({ agent, call_id: `call_p${call}`, system_prompt: system, prompt: arg, resume: true });
      agent.tmux_window_id = rr.window_id;
      log(`resumed window ${rr.window_id} session ${rr.session_id} (asked ${sid})`);
    }
    else if (verb === 'capture') { log('CAPTURE\n' + (await spawner.capture(agent, 60))); }
    else if (verb === 'discover') { log('discover ' + (await spawner.discoverSession(agent, t0))); }
    else if (verb === 'alive') { log('alive ' + (await spawner.isAlive(agent))); }
    else if (verb === 'policy') { policy = arg; log('policy ' + policy); }
    else if (verb === 'setsession') { agent.session_id = arg; log('session ' + arg); }
    else if (verb === 'keys') { await tmux.sendKeys(agent.tmux_window_id, ...rest); log('keys sent'); }
    else if (verb === 'quit') { await spawner.stop(agent); stub.stop(); process.exit(0); }
  } catch (e) {
    log('ERR ' + (e as Error).message);
  }
}
