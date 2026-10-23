#!/bin/bash
# Usage: s5-observe.sh <mode>
cd "$(dirname "$0")"
mode=$1
rm -f work/s5-$mode.json work/late-$mode.txt work/fg-$mode.txt
env -i PATH="$PATH" HOME="$HOME" USER="$USER" LANG="${LANG:-en_US.UTF-8}" TMPDIR="$TMPDIR" SHELL="$SHELL" node s5-hostexit.mjs $mode 2>&1 | grep -v hook_
echo "host exited rc=${PIPESTATUS[0]} at $(date +%T)"
pids=$(node -e 'const s=require("./work/s5-'$mode'.json");console.log([s.child,...s.descendants.map(d=>d.pid)].join(" "))')
echo "tracked: $pids"
for t in 3 10 30; do
  sleep $t
  echo "--- after +${t}s"
  for p in $pids; do ps -o pid=,ppid=,pgid=,stat=,command= -p $p 2>/dev/null | cut -c1-120 || true; done
done
ls work/ | grep -E "late-$mode|fg-$mode" || echo "no output files"
