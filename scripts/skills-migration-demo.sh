#!/bin/sh
# Migration UI demo: a Sparrow server on :4430 over .sandbox/mig-home (a byte-copy of a sandbox HOME; never the real one).
#   scripts/skills-migration-demo.sh        start      scripts/skills-migration-demo.sh down   stop
set -e
WT="$(cd "$(dirname "$0")/.." && pwd)"
H="$WT/.sandbox/mig-home"
export SPARROW_HOME="$H/.sparrow" SPARROW_PORT=4430 SPARROW_TMUX_SOCKET=sparrow-skills-p2m SPARROW_TMUX_PREFIX=p2m- SPARROW_SKILLS_HOME="$H"
unset SPARROW_URL SPARROW_AGENT_ID SPARROW_CALL_ID
if [ "$1" = down ]; then "$WT/bin/sparrow" stop || true; tmux -L sparrow-skills-p2m kill-server 2>/dev/null || true; exit 0; fi
cd "$WT"
nohup bun bin/sparrow up --port 4430 > "$WT/.sandbox/mig-server.out" 2>&1 &
sleep 3
curl -s http://127.0.0.1:4430/api/health
