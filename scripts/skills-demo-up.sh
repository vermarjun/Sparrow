#!/bin/sh
# Phase-2 demo instance: sandbox HOME fixture + a Sparrow server on :4420 (never touches the real ~/.claude, ~/.sparrow, …).
#   scripts/skills-demo-up.sh        rebuild the fixture and start
#   scripts/skills-demo-up.sh down   stop it and kill its tmux server
set -e
WT="$(cd "$(dirname "$0")/.." && pwd)"
export SPARROW_HOME="$WT/.sandbox/home/.sparrow" SPARROW_PORT=4420 SPARROW_TMUX_SOCKET=sparrow-skills-p2 SPARROW_TMUX_PREFIX=p2- SPARROW_SKILLS_HOME="$WT/.sandbox/home"
unset SPARROW_URL SPARROW_AGENT_ID SPARROW_CALL_ID
stop() {
  if [ -f "$SPARROW_HOME/server.pid" ]; then kill "$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$SPARROW_HOME/server.pid")" 2>/dev/null || true; fi
  sleep 1
  tmux -L sparrow-skills-p2 kill-server 2>/dev/null || true
}
stop
[ "$1" = down ] && exit 0
bun "$WT/scripts/skills-demo-fixture.ts"
cd "$WT"
nohup bun bin/sparrow up --port 4420 > "$WT/.sandbox/server.out" 2>&1 &
sleep 3
curl -s http://127.0.0.1:4420/api/health
