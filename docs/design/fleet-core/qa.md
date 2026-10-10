# Fleet core: manual QA runbook

For spec section 12, done criterion 3, and section 9's "Manual QA" row. It checks the fleet on `cp.example`: the fleet service, the hub in fleet mode and a local agent. It adds a **test** agent on the owner's PC. The evidence it produces goes into `qa/<date>-fleet-core.md`, with screenshots in `qa/img-fleet/`.

**Run it** after Tasks 1–19 are merged into the branch under test, with CI green on it. It takes about an hour. Three shells take part, all driven from the Mac:
- the Mac, which drives everything;
- the control plane (`ssh operator@cp.example`);
- WSL on the PC (`ssh devbox`, the owner's alias that lands in WSL).

Every block says where it runs, what to expect, and which evidence file it writes.

**Every Linux block (control plane and PC) runs as its own `bash -s`**: send it on stdin (`ssh "$CP" bash -s`, `ssh "$PC_WSL" bash -s`), or start `bash` first and paste it there. The blocks use bash-isms (`/dev/tcp`, arrays) and `exit`, and some start with `set -euo pipefail`; that ends only the block's own shell, which is the point: a block that fails stops before the next line. Mac blocks are zsh.

## The rules

1. **Nothing here touches the PC's live system.** That means:
   - not the default tmux server, its session `main` or any lane;
   - not kira or its port 8787;
   - not the live hub or `~/.local/share/morndo`;
   - not `~/.claude`, and certainly not `~/.claude/settings.json`.

   The PC's test agent runs with `HOME=~/morndo-qa/home`, so its config, key, database and `.claude` all live there. Its scratch lane is a fake input box (`test/fixtures/fake-claude-pane.ts`), not Claude Code, so no real hook fires into kira.
2. **On the PC, every tmux command goes through `TT`** (`tmux -L morndo-test`), and on the control plane through `TQ` (`tmux -L morndo-qa`). A bare `tmux` in a block is a mistake: stop.
3. **Every PC step needs the owner's go-ahead** (PC-0), and so does the PC cleanup, C-2. The Mac and control-plane steps don't: they use their own directories and ports.
4. **The QA's own ports:**
   - the hub on 18790;
   - the fleet on 18791;
   - the relays on 18787;
   - the Mac's end of the tunnel on 28791.

   Never 8787, 8790 or 8791.
5. **Join strings and cookies are secrets.** They never go into evidence: the blocks redact them.
6. **When an Expect doesn't hold, stop.** Keep everything running, save the output as evidence, and find out why before going on. Clean up only once the evidence is safe.
7. **Every block starts by sourcing its machine's variables file** (section 0): `. /tmp/morndo-qa-vars.sh` on the Mac, `. ~/morndo-qa.vars.sh` on the control plane and the PC. The branch under test is set once, in the Mac's file.
8. **Cleanup removes only what this runbook created** (each path is listed in section 4), and only when the marker `$QA/.created-by-fleet-qa` holds this run's ID (CP-2, PC-2): without it a cleanup block refuses and stops. It kills a process from a pid file only if the process is running and its working directory is under `$QA` (a recycled PID never is), and the PC's cleanup runs only if `$EVID/pc-00-go-ahead.txt` holds the line `go-ahead: yes`. It never runs `git worktree prune` in the owner's repositories (it removes its own worktree by its path), never kills a tmux server but `morndo-qa` and `morndo-test`, and never touches the live tmux server `main`, kira or `~/.claude/settings.json`.

## 0. Variables

Each machine has one variables file, and every block below starts by sourcing it (rule 7), so a new shell or a block run on its own has the same values. The branch under test is set once, in the Mac's file (plan.md, "Branches and worktrees": `feat/fleet-core`), and the Mac writes it into the other two. Node is pinned on both Linux hosts: `~/.nvm/versions/node/v24.21.0/bin/node`, never whatever `node` the `PATH` finds.

**V-1 Mac** (zsh). The run ID tells this run's marker from anyone else's (rule 8); the file, run ID included, is written by one redirect, so a second V-1 fails on it (`file exists`) and changes nothing:

```sh
set -o noclobber
sed "s|@RUNID@|fleetqa-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM|" > /tmp/morndo-qa-vars.sh <<'EOF'
# The fleet QA's variables on the Mac (docs/design/fleet-core/qa.md, section 0). Every Mac block sources this file.
export RUNID=@RUNID@
export BRANCH=feat/fleet-core                     # the branch under test, set here and nowhere else
export CP=operator@cp.example PC_WSL=devbox
export EVID=/tmp/morndo-qa-evidence MACREPO=/tmp/morndo-qa-mac
pair() { ssh "$CP" bash -s <<'EOS' | grep -o 'http://localhost:18790/pair#[^ ]*'
. ~/morndo-qa.vars.sh; cd "$REPO"; env "${HUB_ENV[@]}" "$NODE" --no-warnings apps/hub/src/main.ts pair
EOS
}
shots() { (cd "$MACREPO" && node --no-warnings e2e/fleet-qa.ts shots "$(pair)" "$EVID/img" "$@"); }
# Closes a tunnel from its pid file, only if that pid is still an `ssh -N` forwarding one of this runbook's own ports (18790, 28791, 18791), so a recycled pid, or a tunnel of the owner's, is never killed.
stop_tunnel() { local pid; pid=$(cat "$1" 2>/dev/null) || { echo "no pid file $1"; return 0; }
  if ps -o command= -p "$pid" 2>/dev/null | grep -Eq '^ssh -N .*-[LR] 127\.0\.0\.1:(18790:127\.0\.0\.1:18790|28791:127\.0\.0\.1:18791|18791:127\.0\.0\.1:28791)( |$)'; then kill "$pid"; echo "closed tunnel $pid"; else echo "not killing $pid ($1): not running, or not our tunnel"; fi; }
EOF
set +o noclobber
. /tmp/morndo-qa-vars.sh; mkdir -p "$EVID/img"; echo "$BRANCH $RUNID"
```

Expect: `feat/fleet-core fleetqa-<date>-<number>`. `file exists` means an earlier QA left its file: stop.

**V-2 The control plane's file, written from the Mac.** The `@…@` placeholders are filled from the Mac's file, so the heredoc needs no escaping. Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
sed -e "s|@BRANCH@|$BRANCH|" -e "s|@RUNID@|$RUNID|" <<'EOF' | ssh "$CP" 'set -o noclobber; cat > ~/morndo-qa.vars.sh'
# The fleet QA's variables on the control plane, written from the Mac (qa.md, section 0). Every block here sources it.
export BRANCH='@BRANCH@' RUNID='@RUNID@'
export NODE="$HOME/.nvm/versions/node/v24.21.0/bin/node" QA="$HOME/morndo-qa"
export QAR="$(readlink -f "$QA")"                     # $QA with links resolved: a process's working directory is shown resolved
export PATH="$(dirname "$NODE"):$PATH" REPO="$HOME/morndo-qa/repo" SOCK="$HOME/morndo-qa/run/fleet.sock"
qa() { "$NODE" --no-warnings "$REPO/e2e/fleet-qa.ts" "$@"; }
TQ() { tmux -L morndo-qa "$@"; }
# What listens on the live ports 8787, 8790 and 8791 (CP-1 records it, CP-5b compares).
live() { ss -ltnH | awk '{print $4}' | grep -E ':(8787|8790|8791)$' | sort || true; }
# Cleanup guards (C-4): refuse unless $QA is this run's; stop a pid-file process only if it is ours.
mine() { [ -n "${RUNID:-}" ] && [ "$(cat "$QA/.created-by-fleet-qa" 2>/dev/null)" = "$RUNID" ] || { echo "REFUSED: $QA is not this run's (no marker with $RUNID): nothing removed, nothing killed"; exit 1; }; }
stop_ours() { local pid; [ -n "${QAR:-}" ] || { echo "REFUSED: QAR is empty, nothing stopped"; return 1; }
  pid=$(cat "$1" 2>/dev/null) || { echo "no pid file $1"; return 0; }
  if kill -0 "$pid" 2>/dev/null && case "$(readlink "/proc/$pid/cwd" 2>/dev/null)" in "$QAR"/*) true;; *) false;; esac; then kill "$pid"; echo "stopped $pid ($1)"; else echo "not stopping $pid ($1): not running, or not started from $QA"; fi; }
if [ -f "$QA/hub.vars" ]; then . "$QA/hub.vars"; fi     # HUB_HOME and HUB_ENV, from CP-2 on
EOF
ssh "$CP" 'bash -s' <<'EOS'
. ~/morndo-qa.vars.sh; echo "$BRANCH $RUNID $NODE"
EOS
```

Expect: `feat/fleet-core fleetqa-… /home/owner/.nvm/versions/node/v24.21.0/bin/node`. `cannot overwrite existing file` means an earlier QA left its file: stop (CP-1 would find its `~/morndo-qa` too).

The PC's file is written the same way in PC-1, only after the owner's go-ahead. The guards test a process's working directory, not its command line, because every service here is started after `cd "$REPO"` with a relative script path.

## 1. Mac

**M-1 Preflight.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
{ node --version; lsof -nP -iTCP:18790 -sTCP:LISTEN; lsof -nP -iTCP:28791 -sTCP:LISTEN; ssh "$CP" 'hostname'; } 2>&1 | tee "$EVID/m-01-preflight.txt"
```

Expect:
- `v24.12` or newer;
- nothing listening on 18790 or 28791;
- `cp.example`.

Nothing touches the PC before PC-0.

**M-2 A worktree for the screenshots.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
git -C ~/Projects/morndo fetch origin "$BRANCH"
git -C ~/Projects/morndo worktree add --detach "$MACREPO" "origin/$BRANCH"
cd "$MACREPO" && npm ci && npx playwright install chromium && git log --oneline -1 | tee "$EVID/m-02-revision.txt"
```

Expect: `npm ci` ends without an error, and the revision is the one under test. It needs about 0.6 GB on the Mac's disk, and C-5 removes it. Playwright's Chromium stays in its shared cache.

## 2. Control plane (no go-ahead needed)

**CP-1 Preflight, read-only.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh
{ hostname; uname -sr; "$NODE" --version; command -v tmux && TQ -V; git -C ~/morndo status --short --branch | head -3
  ss -ltn | grep -E ':(18787|18790|18791)\b' || echo "ports 18787, 18790, 18791 free"
  test -e "$QA" && echo "STOP: $QA exists" || echo "$QA absent"; df -h "$HOME" | tail -1; } 2>&1 | tee /tmp/cp-01-preflight.txt
live | tee /tmp/cp-01-live.txt          # what listens on 8787, 8790, 8791 now (the live hub, perhaps): CP-5b shows it unchanged
```

Expect:
- `cp.example`, `Linux …`, `v24.21.0`;
- `tmux 3.4` or newer;
- `ports … free`;
- `… absent`.

If tmux is missing, stop and ask the owner: installing packages on the control plane belongs to sub-project 3.

**CP-2 Directories, worktree, dependencies, build.** Run on the control plane:

```sh
set -euo pipefail
. ~/morndo-qa.vars.sh
trap 'rm -f /tmp/cp-01-preflight.txt /tmp/cp-01-live.txt' EXIT    # nothing of the preflight stays in /tmp, whatever fails below
mkdir -m 700 "$QA"                                                 # fails if it exists: never write into someone else's directory
echo "$RUNID" > "$QA/.created-by-fleet-qa"                         # the marker C-4 insists on
mkdir -p "$QA"/{evidence,logs,lane,hub-home,hub-inbox}
mkdir -m 700 "$QA/run"
mv /tmp/cp-01-preflight.txt /tmp/cp-01-live.txt "$QA/evidence/"
HUB_HOME=$(mktemp -d /tmp/morndo-qa-hub-XXXXXX)          # e2e/qa-session.ts accepts only a morndo-* dir in /tmp
cat > "$QA/hub.vars" <<EOF
HUB_HOME='$HUB_HOME'
HUB_ENV=(HOME='$QA/hub-home' MORNDO_HOME='$HUB_HOME' MORNDO_PORT=18790 MORNDO_ORIGIN=http://localhost:18790 MORNDO_FLEET_SOCKET='$SOCK' MORNDO_POLL_MS=1000 MORNDO_INBOX='$QA/hub-inbox' 'MORNDO_OFFICE_NAME=Fleet QA')
EOF
. ~/morndo-qa.vars.sh                                      # now with HUB_HOME and HUB_ENV
git -C ~/morndo fetch origin "$BRANCH"
git -C ~/morndo worktree add --detach "$REPO" "origin/$BRANCH"
cd "$REPO"
npm ci
npm run build
git log --oneline -1 | tee "$QA/evidence/cp-02-revision.txt"
```

Expect: the block ends without a failure, the same revision as `m-02-revision.txt`, and `apps/web/build/200.html` exists. (Every step is its own line, so `set -e` stops the block at the first one that fails, `npm ci` and `npm run build` included, and no revision line is printed; a failure in the middle of an `&&` chain would not stop it, which is why there are none in this block. A failed block leaves `$QA` behind: C-4 removes it.) If `git fetch` can't authenticate here, stop and ask; don't copy keys onto the server.

**CP-3 The fleet service.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh
mkdir -p "$QA/fleet-home/.config/morndo-fleet"
cat > "$QA/fleet-home/.config/morndo-fleet/config.json" <<EOF
{ "listen": { "host": "127.0.0.1", "port": 18791 }, "socketPath": "$SOCK",
  "dbPath": "$QA/fleet-home/.local/share/morndo-fleet/fleet.db",
  "keyPath": "$QA/fleet-home/.local/share/morndo-fleet/fleet-key.pem",
  "publicUrl": "ws://127.0.0.1:18791/agent", "subscribers": [] }
EOF
cd "$REPO"
HOME=$QA/fleet-home nohup "$NODE" --no-warnings apps/fleet/src/main.ts serve > "$QA/logs/fleet.log" 2>&1 & echo $! > "$QA/fleet.pid"
sleep 2
{ HOME=$QA/fleet-home "$NODE" --no-warnings apps/fleet/src/main.ts status; qa nodes "$SOCK"; ss -ltn | grep ':18791\b'; ls -ld "$QA/run"; } 2>&1 | tee "$QA/evidence/cp-03-fleet.txt"
```

Expect: `fleet service: running (…/morndo-qa/run/fleet.sock)`, `hook bus: no subscribers` and `alerts in the last 24 h: none`; `qa nodes` prints nothing; 127.0.0.1:18791 is listening; `$QA/run` is `drwx------`.

If nothing listens, read `$QA/logs/fleet.log` before anything else. The fleet checks its socket first and exits 78 (`SocketInUse`) when another live fleet holds it. Another QA's leftovers are the usual cause: stop, and don't kill what you didn't start.

**CP-4 The hub, in fleet mode, on a throwaway data directory.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh; cd "$REPO"
nohup env "${HUB_ENV[@]}" "$NODE" --no-warnings apps/hub/src/main.ts serve > "$QA/logs/hub.log" 2>&1 & echo $! > "$QA/hub.pid"
sleep 3; grep -m1 'morndo hub on' "$QA/logs/hub.log" | tee "$QA/evidence/cp-04-hub.txt"
"$NODE" --no-warnings e2e/qa-session.ts "$HUB_HOME" "QA curl" > "$QA/cookie" && chmod 600 "$QA/cookie" && echo "cookie saved (not shown)" | tee -a "$QA/evidence/cp-04-hub.txt"
```

Expect: `[hub] info: morndo hub on http://127.0.0.1:18790, for http://localhost:18790`, then `cookie saved (not shown)`.

`MORNDO_FLEET_SOCKET` must be an absolute path: a relative one makes every hub command throw at startup, `pair` and `audit` included. `$SOCK` is absolute, so keep using it. The hub starts even when the fleet is down and then shows a "Fleet unavailable" banner: if a screenshot shows that banner, the fleet isn't answering on `$SOCK`.

**CP-5 A local agent `cp`: join, then its config, checked.** Run on the control plane:

```sh
set -euo pipefail
. ~/morndo-qa.vars.sh; cd "$REPO"
JOIN=$(HOME=$QA/fleet-home "$NODE" --no-warnings apps/fleet/src/main.ts node add cp | grep -o 'morndo-join:1:[A-Za-z0-9_-]*')
echo "join string: ${#JOIN} characters (not shown)" | tee "$QA/evidence/cp-05-agent.txt"
HOME=$QA/cp-home "$NODE" --no-warnings apps/node-agent/src/main.ts join "$JOIN" 2>&1 | sed -E 's/morndo-join:1:[A-Za-z0-9_-]+/morndo-join:1:[redacted]/g' | tee -a "$QA/evidence/cp-05-agent.txt"
unset JOIN
HOME=$QA/cp-home "$NODE" -e '
const fs = require("node:fs"), d = `${process.env.HOME}/.config/morndo-node`, f = `${d}/config.json`;
const sock = process.argv[1], port = Number(process.argv[2]);
const c = JSON.parse(fs.readFileSync(f, "utf8"));
c.relayPort = port;
fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 });
fs.writeFileSync(`${d}/policy.json`, JSON.stringify({ session: "qa", tmuxSocket: sock, repoRoots: [], lockedPanes: {} }, null, 2), { mode: 0o600 });
const c2 = JSON.parse(fs.readFileSync(f, "utf8")), p2 = JSON.parse(fs.readFileSync(`${d}/policy.json`, "utf8"));
console.log(JSON.stringify({ node: c2.node, fleetUrl: c2.fleetUrl, relayPort: c2.relayPort, policy: p2 }));
if (c2.relayPort !== port || p2.tmuxSocket !== sock || p2.session !== "qa") { console.error("REFUSED: the read-back is not the QA config"); process.exit(1); }' morndo-qa 18787 | tee -a "$QA/evidence/cp-05-agent.txt"
qa agent-config "$QA/cp-home" morndo-qa 18787 | tee -a "$QA/evidence/cp-05-agent.txt"
```

Expect:
- the join string's length only;
- `Joined the fleet at ws://127.0.0.1:18791/agent as cp.`;
- the config line with `"fleetUrl":"ws://127.0.0.1:18791/agent"`, `"relayPort":18787`, and a policy read back from `policy.json` with `"session":"qa"` and `"tmuxSocket":"morndo-qa"`;
- `agent config ok: node cp, relayPort 18787, tmuxSocket morndo-qa, session qa`.

The block stops at the first failure and exits non-zero (a failed `join`, a failed write, a read-back that differs). **Without that last line, do not start the agent**: a config the patch didn't finish leaves the defaults, `tmuxSocket: null` (the default tmux server) and relay port 8787.

**CP-5b The scratch lane, then the agent.** Run only after CP-5's Expect holds. It checks the files on disk again before it starts anything. Run on the control plane:

```sh
set -euo pipefail
. ~/morndo-qa.vars.sh; cd "$REPO"
qa agent-config "$QA/cp-home" morndo-qa 18787                  # exits 1, and nothing below runs, unless the config on disk is the QA's
echo "cp-scratch on cp (QA)" > "$QA/lane/prose.txt"
TQ new-session -d -s qa -n cp-scratch -x 120 -y 30 -c "$QA/lane" "$NODE" --no-warnings "$REPO/test/fixtures/fake-claude-pane.ts" "$QA/lane" --claude="$QA/cp-home/.claude" --session="$(cat /proc/sys/kernel/random/uuid)" --tmux-session=qa
HOME=$QA/cp-home nohup "$NODE" --no-warnings apps/node-agent/src/main.ts run > "$QA/logs/cp-agent.log" 2>&1 & echo $! > "$QA/cp-agent.pid"
for i in $(seq 1 20); do ss -ltn | grep -q ':18787\b' && break; sleep 1; done
{ ss -ltn | grep ':18787\b' || { echo "FAIL: no relay on 18787"; stop_ours "$QA/cp-agent.pid"; exit 1; }
  if [ "$(live)" = "$(cat "$QA/evidence/cp-01-live.txt")" ]; then echo "8787/8790/8791 listeners unchanged: PASS"; else echo "8787/8790/8791 listeners CHANGED: FAIL"; live; stop_ours "$QA/cp-agent.pid"; exit 1; fi
  sleep 3; qa nodes "$SOCK"; qa lanes "$SOCK"; } | tee -a "$QA/evidence/cp-05-agent.txt"
```

Expect:
- a `LISTEN` line for 127.0.0.1:18787 (the relay is up on the QA port);
- `8787/8790/8791 listeners unchanged: PASS`;
- `cp  online  <version>`;
- `cp-scratch  cp  cp.<8 hex>.0`.

On a FAIL the block stops the agent it just started (by the guarded pid file) and exits 1: keep the evidence, find out why, and don't go on.

**CP-6 Mac: tunnels, and the hub with one node.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18790:127.0.0.1:18790 -L 127.0.0.1:28791:127.0.0.1:18791 "$CP" & echo $! > /tmp/morndo-qa-tunnel-cp.pid
sleep 2; shots list:cp-06-hub-one-node.png | tee "$EVID/cp-06-shots.txt"
```

Expect: `list:cp-06-hub-one-node.png -> …` and `this QA device revoked itself: 200`. The screenshot lists `cp-scratch`.

**CP-7 A send and a frame on the control plane's node.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
shots "send:cp-scratch:hello cp from the hub:cp-07-send.png" terminal:cp-scratch:cp-07-frame.png | tee "$EVID/cp-07-shots.txt"
```

Then run on the control plane:

```sh
. ~/morndo-qa.vars.sh
cat "$QA/lane/submitted.jsonl" | tee "$QA/evidence/cp-07-submitted.txt"
```

Expect `"hello cp from the hub"`, exactly once. `cp-07-send.png` shows the message in cp-scratch's conversation, and `cp-07-frame.png` shows the Terminal tab with "cp-scratch on cp (QA)" and the input box.

**CP-8 The drop-after-paste drill.** The control plane's agent restarts with the test hook for one request ID only; every other send behaves normally. Run on the control plane:

```sh
. ~/morndo-qa.vars.sh; cd "$REPO"
"$NODE" --no-warnings e2e/qa-session.ts "$HUB_HOME" --reverify "$(cat "$QA/cookie")" | tee "$QA/evidence/cp-08-reverify.txt"
COOKIE=$(cat "$QA/cookie"); WID=$(qa worker "$SOCK" cp-scratch); RID=$(cat /proc/sys/kernel/random/uuid)
qa agent-config "$QA/cp-home" morndo-qa 18787 || exit 1      # a gate: this block has no set -e
stop_ours "$QA/cp-agent.pid"; sleep 2
HOME=$QA/cp-home NODE_ENV=test MORNDO_NODE_TEST_HOOKS="{\"dropAfterStarted\":\"$RID\"}" nohup "$NODE" --no-warnings apps/node-agent/src/main.ts run > "$QA/logs/cp-agent-drill.log" 2>&1 & echo $! > "$QA/cp-agent.pid"
sleep 5
{ echo "worker $WID, request $RID"
  echo "1st:"; qa send 18790 "$COOKIE" "$WID" "qa drill: drop after the paste" "$RID"
  sleep 4; qa nodes "$SOCK"
  echo "repeat:"; qa send 18790 "$COOKIE" "$WID" "qa drill: drop after the paste" "$RID"
  echo "typed: $(grep -c 'qa drill: drop after the paste' "$QA/lane/submitted.jsonl")"
  grep -i -m3 'hook' "$QA/logs/cp-agent-drill.log"; } 2>&1 | tee "$QA/evidence/cp-08-drop-after-paste.txt"
unset COOKIE
```

Expect:
- `verified now` first. A send needs a session whose passkey was checked recently (the hub's step-up window), and the QA cookie was checked in CP-4; `e2e/qa-session.ts --reverify` marks it checked now, so a 403 `step_up` can't stand in for the drill's answers. PC-7 and PC-8 do the same before their sends;
- `1st:` then `409 {"error":"uncertain"}`: the node's answer was "maybe", and the hub keeps its started row (plan Contracts, "The hub's answers to a send"; a 500 `{"error":"internal error"}` until the final review's I1);
- `cp  online`, since it reconnected;
- `repeat:` then `200 {"error":"duplicate","ok":true,…}`;
- `typed: 1`;
- the log lines `warn: test hooks are on (dropAfterStarted): this agent is for tests only` and `warn: test hook dropAfterStarted: the answer to a pane.send request is not sent` (the first is the agent's warning about active test hooks, the second is the drop itself).

The agent accepts the hook only because `NODE_ENV=test` is set and its `HOME` (`$QA/cp-home`) isn't the account's own; without `NODE_ENV=test`, `run` exits 78 and says why.

Then run on the Mac: `. /tmp/morndo-qa-vars.sh; shots lane:cp-scratch:cp-08-drop-drill.png`. The conversation shows the message once.

**CP-9 Back to normal.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh; cd "$REPO"; qa agent-config "$QA/cp-home" morndo-qa 18787 || exit 1      # a gate: this block has no set -e
stop_ours "$QA/cp-agent.pid"; sleep 2
HOME=$QA/cp-home nohup "$NODE" --no-warnings apps/node-agent/src/main.ts run > "$QA/logs/cp-agent.log" 2>&1 & echo $! > "$QA/cp-agent.pid"
sleep 5; { qa nodes "$SOCK"; echo "test hook warnings: $(grep -cE 'test hooks? ' "$QA/logs/cp-agent.log")"; echo "alerts:"; qa alerts "$SOCK"; } | tee "$QA/evidence/cp-09-normal.txt"
```

Expect: `cp  online`; `test hook warnings: 0` (the agent's warning about active hooks reads `test hooks are on (…)` and the drop's own line `test hook dropAfterStarted: …`; a plain `hook` would also match the relay's own lines); and under `alerts:` nothing, or only lines the record explains (a `clock_offset` would mean this host's clock is more than 2 s off: record the offset).

## 3. The PC test agent: **OWNER'S GO-AHEAD REQUIRED for every step**

**PC-0 Ask.** Send the owner this, and wait for his answer:

> Fleet QA, PC part: may I run a TEST node agent on the PC for about 30 minutes? It runs from `~/morndo-qa` only, with HOME set there. It gets its own tmux server (`tmux -L morndo-test`) holding one scratch pane: a fake input box, no Claude Code. Its relay is on 127.0.0.1:18787, and it reaches the control plane's QA fleet through an SSH tunnel from the Mac (127.0.0.1:18791 on the PC). It never touches tmux `main`, kira (8787), the live hub, `~/.claude` or `~/.claude/settings.json`. I'll restart its own test tmux server once, for a drill, and stop it once. The cleanup removes all of it.

Record his answer on the Mac, in `$EVID/pc-00-go-ahead.txt`. Its first line is exactly `go-ahead: yes` if he said yes, and exactly `go-ahead: no` for anything else; the time and his words follow, verbatim:

```sh
. /tmp/morndo-qa-vars.sh
{ echo 'go-ahead: yes'; date -u +%FT%TZ; echo 'owner, verbatim: <his words>'; } > "$EVID/pc-00-go-ahead.txt"      # or 'go-ahead: no'
```

The PC's cleanup and the PC half of C-1 run only if that file holds the line `go-ahead: yes` (`grep -qx`): a recorded no, or an empty file, doesn't pass. **Without a yes, stop here.** Record the PC part as not done; done criterion 3 then stays open.

**PC-1 The PC's variables file, then a preflight, read-only.** Run on the Mac (as V-2 did for the control plane):

```sh
. /tmp/morndo-qa-vars.sh
sed -e "s|@BRANCH@|$BRANCH|" -e "s|@RUNID@|$RUNID|" <<'EOF' | ssh "$PC_WSL" 'set -o noclobber; cat > ~/morndo-qa.vars.sh'
# The fleet QA's variables on the PC (WSL), written from the Mac (qa.md, PC-1). Every PC block sources it.
export BRANCH='@BRANCH@' RUNID='@RUNID@'
export NODE="$HOME/.nvm/versions/node/v24.21.0/bin/node" QA="$HOME/morndo-qa"
export QAR="$(readlink -f "$QA")"                     # $QA with links resolved: a process's working directory is shown resolved
export PATH="$(dirname "$NODE"):$PATH" REPO="$HOME/morndo-qa/repo"     # npm and node from the pinned Node, never the Windows side's
qa() { "$NODE" --no-warnings "$REPO/e2e/fleet-qa.ts" "$@"; }
TT() { tmux -L morndo-test "$@"; }
# What listens on kira's port 8787 (PC-1 records it, PC-4b and C-2 compare).
live() { ss -ltnH | awk '{print $4}' | grep -E ':8787$' | sort || true; }
# Cleanup guards (C-2): refuse unless $QA is this run's; stop a pid-file process only if it is ours.
mine() { [ -n "${RUNID:-}" ] && [ "$(cat "$QA/.created-by-fleet-qa" 2>/dev/null)" = "$RUNID" ] || { echo "REFUSED: $QA is not this run's (no marker with $RUNID): nothing removed, nothing killed"; exit 1; }; }
stop_ours() { local pid; [ -n "${QAR:-}" ] || { echo "REFUSED: QAR is empty, nothing stopped"; return 1; }
  pid=$(cat "$1" 2>/dev/null) || { echo "no pid file $1"; return 0; }
  if kill -0 "$pid" 2>/dev/null && case "$(readlink "/proc/$pid/cwd" 2>/dev/null)" in "$QAR"/*) true;; *) false;; esac; then kill "$pid"; echo "stopped $pid ($1)"; else echo "not stopping $pid ($1): not running, or not started from $QA"; fi; }
EOF
ssh "$PC_WSL" 'bash -s' <<'EOS'
. ~/morndo-qa.vars.sh; echo "$BRANCH $RUNID $NODE"
EOS
```

Expect: `feat/fleet-core fleetqa-… /home/<user>/.nvm/versions/node/v24.21.0/bin/node`.

Then run on the PC:

```sh
. ~/morndo-qa.vars.sh
{ hostname; grep -o 'microsoft[^ ]*' /proc/version; "$NODE" --version; TT -V
  echo "listening:"; ss -ltn | grep -E ':(8787|18787|18791)\b'
  TT ls 2>&1 | head -1
  test -e "$QA" && echo "STOP: $QA exists" || echo "$QA absent"
  sha256sum ~/.claude/settings.json | tee /tmp/pc-01-settings.sha256; df -h "$HOME" | tail -1; } 2>&1 | tee /tmp/pc-01-preflight.txt
live | tee /tmp/pc-01-live.txt          # what listens on 8787 now (kira): PC-4b and C-2 show it unchanged
```

Expect:
- a WSL2 kernel (the `microsoft…` part; if it's missing, `$PC_WSL` doesn't land in WSL: stop);
- `v24.21.0` (the pinned Node; if the file is missing, stop: nvm's 24.21.0 is what the services run on);
- tmux 3.4 or newer;
- under `listening:`, exactly one line, for 8787 (live kira); 18787 and 18791 are free;
- `no server running on …/morndo-test`;
- `… absent`;
- a hash of `settings.json`, which PC-2 stores and C-2 compares by machine.

**PC-2 Directory, clone, dependencies.** Run on the PC:

```sh
set -euo pipefail
. ~/morndo-qa.vars.sh
trap 'rm -f /tmp/pc-01-preflight.txt /tmp/pc-01-settings.sha256 /tmp/pc-01-live.txt' EXIT    # nothing of the preflight stays in /tmp, whatever fails below
mkdir -m 700 "$QA"                                                 # fails if it exists: never write into someone else's directory
echo "$RUNID" > "$QA/.created-by-fleet-qa"                         # the marker C-2 insists on
mkdir -p "$QA"/{evidence,logs,lane,home}
mv /tmp/pc-01-preflight.txt /tmp/pc-01-live.txt "$QA/evidence/"
mv /tmp/pc-01-settings.sha256 "$QA/settings.sha256"               # C-2 compares against this file
git clone --quiet --depth 1 --branch "$BRANCH" git@github.com:morndo/morndo.git "$REPO"
cd "$REPO"
npm ci
git log --oneline -1 | tee "$QA/evidence/pc-02-revision.txt"
```

Expect: the block ends without a failure (a failed `git clone` or `npm ci` stops it, and no revision line appears) and prints the same revision as `cp-02-revision.txt`. npm's download cache (`~/.npm`) is shared and only grows; it holds no state of this QA.

**PC-3 The tunnel to the control plane's fleet, through the Mac.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:18791:127.0.0.1:28791 "$PC_WSL" & echo $! > /tmp/morndo-qa-tunnel-pc.pid
```

Then run on the PC:

```sh
. ~/morndo-qa.vars.sh
(exec 3<>/dev/tcp/127.0.0.1/18791) && echo "fleet reachable on 127.0.0.1:18791" | tee "$QA/evidence/pc-03-tunnel.txt"
```

Expect: `fleet reachable …`. The path is PC 18791 → the Mac's 28791 → the control plane's 18791 (CP-6). No SSH trust between the PC and the control plane is needed, and nothing is configured on either host.

**PC-4 Join `pc-test`, a scratch lane, run.** Run on the Mac, which carries the join string from the control plane to the PC without it touching any file:

```sh
. /tmp/morndo-qa-vars.sh
JOIN=$(ssh "$CP" bash -s <<'EOS' | grep -o 'morndo-join:1:[A-Za-z0-9_-]*'
. ~/morndo-qa.vars.sh; cd "$REPO"; HOME=$QA/fleet-home "$NODE" --no-warnings apps/fleet/src/main.ts node add pc-test
EOS
)
ssh "$PC_WSL" "JOIN='$JOIN' bash -s" <<'EOS' 2>&1 | sed -E 's/morndo-join:1:[A-Za-z0-9_-]+/morndo-join:1:[redacted]/g' | tee "$EVID/pc-04-join.txt"
. ~/morndo-qa.vars.sh; cd "$REPO"; HOME=$QA/home "$NODE" --no-warnings apps/node-agent/src/main.ts join "$JOIN"; echo "join exit $?"
EOS
unset JOIN
```

Then run on the PC:

```sh
set -euo pipefail
. ~/morndo-qa.vars.sh; cd "$REPO"
HOME=$QA/home "$NODE" -e '
const fs = require("node:fs"), d = `${process.env.HOME}/.config/morndo-node`, f = `${d}/config.json`;
const sock = process.argv[1], port = Number(process.argv[2]);
const c = JSON.parse(fs.readFileSync(f, "utf8"));
c.relayPort = port;
fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 });
fs.writeFileSync(`${d}/policy.json`, JSON.stringify({ session: "qa", tmuxSocket: sock, repoRoots: [], lockedPanes: {} }, null, 2), { mode: 0o600 });
const c2 = JSON.parse(fs.readFileSync(f, "utf8")), p2 = JSON.parse(fs.readFileSync(`${d}/policy.json`, "utf8"));
console.log(JSON.stringify({ node: c2.node, fleetUrl: c2.fleetUrl, relayPort: c2.relayPort, policy: p2 }));
if (c2.relayPort !== port || p2.tmuxSocket !== sock || p2.session !== "qa") { console.error("REFUSED: the read-back is not the QA config"); process.exit(1); }' morndo-test 18787 | tee "$QA/evidence/pc-04-config.txt"
qa agent-config "$QA/home" morndo-test 18787 | tee -a "$QA/evidence/pc-04-config.txt"
```

Expect:
- `join exit 0` (from the block before);
- the config line with `"node":"pc-test"`, `"relayPort":18787`, and a policy read back from `policy.json` with `"session":"qa"` and `"tmuxSocket":"morndo-test"`;
- `agent config ok: node pc-test, relayPort 18787, tmuxSocket morndo-test, session qa`.

The block stops at the first failure and exits non-zero. **If it fails, or the last line is missing, stop and go no further**: an agent started on a config the patch didn't finish would run on the defaults, the PC's default tmux server, where the live lanes run, and relay port 8787, which is kira's.

**PC-4b The scratch lane, then the agent.** Run only after PC-4's Expect holds. Its first line checks the files on disk again, and nothing starts unless it passes. Run on the PC:

```sh
set -euo pipefail
. ~/morndo-qa.vars.sh; cd "$REPO"
qa agent-config "$QA/home" morndo-test 18787                   # exits 1, and nothing below runs, unless the config on disk is the QA's
echo "pc-scratch on pc-test (QA)" > "$QA/lane/prose.txt"
TT new-session -d -s qa -n pc-scratch -x 120 -y 30 -c "$QA/lane" "$NODE" --no-warnings "$REPO/test/fixtures/fake-claude-pane.ts" "$QA/lane" --claude="$QA/home/.claude" --session="$(cat /proc/sys/kernel/random/uuid)" --tmux-session=qa
TT list-panes -a -F '#{session_name}:#{window_name} #{pane_id}' | tee "$QA/evidence/pc-04-panes.txt"
HOME=$QA/home nohup "$NODE" --no-warnings apps/node-agent/src/main.ts run > "$QA/logs/pc-agent.log" 2>&1 & echo $! > "$QA/pc-agent.pid"
for i in $(seq 1 20); do ss -ltn | grep -q ':18787\b' && break; sleep 1; done
{ ss -ltn | grep ':18787\b' || { echo "FAIL: no relay on 18787"; stop_ours "$QA/pc-agent.pid"; exit 1; }
  if [ "$(live)" = "$(cat "$QA/evidence/pc-01-live.txt")" ]; then echo "8787 listeners unchanged: PASS"; else echo "8787 listeners CHANGED: FAIL"; live; stop_ours "$QA/pc-agent.pid"; exit 1; fi; } | tee "$QA/evidence/pc-04-ports.txt"
```

Expect:
- `qa:pc-scratch %0`;
- a `LISTEN` line for 127.0.0.1:18787 (the relay is up on the QA port);
- `8787 listeners unchanged: PASS`.

On a FAIL the block stops the agent it just started (by the guarded pid file) and exits 1.

**PC-5 The hub lists both nodes.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh
sleep 5; { qa nodes "$SOCK"; qa lanes "$SOCK"; } | tee "$QA/evidence/pc-05-both-nodes.txt"
```

Expect: `cp  online` and `pc-test  online`; `cp-scratch  cp  cp.…` and `pc-scratch  pc-test  pc-test.…`.

Then run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
shots list:pc-05-hub-both-nodes.png lane:pc-scratch:pc-05-pc-lane.png | tee "$EVID/pc-05-shots.txt"
```

Expect: `pc-05-hub-both-nodes.png` lists cp-scratch and pc-scratch.

**PC-6 A send and a frame on the PC's node.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
shots "send:pc-scratch:hello pc-test from the control plane:pc-06-send.png" terminal:pc-scratch:pc-06-frame.png | tee "$EVID/pc-06-shots.txt"
```

Then run on the PC:

```sh
. ~/morndo-qa.vars.sh
cat "$QA/lane/submitted.jsonl" | tee "$QA/evidence/pc-06-submitted.txt"
```

Expect `"hello pc-test from the control plane"`, exactly once. The frame shows "pc-scratch on pc-test (QA)", drawn on the PC.

**PC-7 The tmux-restart drill, on the test server only.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh
qa worker "$SOCK" pc-scratch | tee "$QA/evidence/pc-07-old-id.txt"
```

Then run on the PC:

```sh
. ~/morndo-qa.vars.sh
TT kill-server
for i in $(seq 1 50); do TT ls >/dev/null 2>&1 || break; sleep 0.2; done     # kill-server returns before the server is gone (tmux 3.3a); at most 10 s
if TT ls >/dev/null 2>&1; then echo "STOP: the test tmux server is still up after 10 s"; exit 1; fi
mkdir -p "$QA/lane2" && echo "pc-scratch after the restart (QA)" > "$QA/lane2/prose.txt"
TT new-session -d -s qa -n pc-scratch -x 120 -y 30 -c "$QA/lane2" "$NODE" --no-warnings "$REPO/test/fixtures/fake-claude-pane.ts" "$QA/lane2"
TT list-panes -a -F '#{session_name}:#{window_name} #{pane_id}' | tee "$QA/evidence/pc-07-panes-after.txt"
```

Then run on the control plane:

```sh
. ~/morndo-qa.vars.sh; cd "$REPO"
"$NODE" --no-warnings e2e/qa-session.ts "$HUB_HOME" --reverify "$(cat "$QA/cookie")" | tee "$QA/evidence/pc-07-reverify.txt"
OLD=$(cat "$QA/evidence/pc-07-old-id.txt"); NEW=$OLD
for i in $(seq 1 30); do NEW=$(qa worker "$SOCK" pc-scratch 2>/dev/null || echo "$OLD"); [ "$NEW" != "$OLD" ] && break; sleep 1; done
{ echo "old $OLD"; echo "new $NEW"
  qa send 18790 "$(cat "$QA/cookie")" "$OLD" "qa drill: meant for the old pane"; } | tee "$QA/evidence/pc-07-restart.txt"
```

Then run on the PC:

```sh
. ~/morndo-qa.vars.sh
sleep 2; { test -s "$QA/lane2/submitted.jsonl" && cat "$QA/lane2/submitted.jsonl" || echo "the new pane received nothing"; } | tee "$QA/evidence/pc-07-new-pane.txt"
```

Expect:
- `verified now` (the cookie's step-up, as in CP-8);
- `qa:pc-scratch %0` again: tmux reused the pane number;
- `old pc-test.<a>.0` and `new pc-test.<b>.0`, where a ≠ b (a new server stamp) and the pane number is the same;
- the send to the old ID answers `404 {"error":"no_pane"}`;
- `the new pane received nothing`.

Then run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
shots list:pc-07-after-restart.png
```

The screenshot shows pc-scratch listed again.

**PC-8 Stopping the PC test agent marks only its lanes offline.** Run on the PC:

```sh
. ~/morndo-qa.vars.sh
stop_ours "$QA/pc-agent.pid" | tee "$QA/evidence/pc-08-stop.txt"
```

Then run on the control plane:

```sh
. ~/morndo-qa.vars.sh; cd "$REPO"
"$NODE" --no-warnings e2e/qa-session.ts "$HUB_HOME" --reverify "$(cat "$QA/cookie")" | tee "$QA/evidence/pc-08-reverify.txt"
sleep 5; { qa nodes "$SOCK"; qa lanes "$SOCK"
  echo "send to cp:"; qa send 18790 "$(cat "$QA/cookie")" "$(qa worker "$SOCK" cp-scratch)" "cp is still steered after pc-test stopped"
  echo "send to pc:"; qa send 18790 "$(cat "$QA/cookie")" "$(qa worker "$SOCK" pc-scratch)" "pc-test is offline"
  echo "alerts:"; qa alerts "$SOCK"; } | tee "$QA/evidence/pc-08-offline.txt"
grep -c 'cp is still steered' "$QA/lane/submitted.jsonl"
```

Then run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
shots list:pc-08-pc-offline.png
```

Expect:
- `stopped <pid> (…/pc-agent.pid)` from the PC's block, then, from the control plane's block, `verified now` (the cookie's step-up, as in CP-8);
- `pc-test  offline` and `cp  online`;
- `send to cp:` then `200 {"ok":true,…}`, and the grep prints `1`;
- `send to pc:` then `409 {"error":"node_offline"}`: refused before anything was typed;
- the screenshot still lists both lanes (an offline node's workers stay listed, never gone), with the offline marker on pc-scratch only (Task 15b);
- under `alerts:`, no `instance_conflict`; any other line is explained in the record (a `clock_offset` for `pc-test` means the PC's clock is more than 2 s off the control plane's: record the offset).

## 4. Cleanup

Only what this runbook created goes (rule 8):
- Mac: the worktree `/tmp/morndo-qa-mac` (by its path), the tunnels' pid files `/tmp/morndo-qa-tunnel-*.pid`, and, once the record is committed, `/tmp/morndo-qa-evidence` and `/tmp/morndo-qa-vars.sh`;
- control plane: `~/morndo-qa` (its worktree `~/morndo-qa/repo` removed by its path first), `~/morndo-qa.vars.sh`, the hub's data `/tmp/morndo-qa-hub-*`, the tmux server `morndo-qa`, any `/tmp/cp-01-*` the preflight left, and `/tmp/cp-cleanup.txt` once copied;
- PC: `~/morndo-qa`, `~/morndo-qa.vars.sh`, the tmux server `morndo-test`, and any `/tmp/pc-01-*` the preflight left.

Nothing else: no `git worktree prune` in `~/Projects/morndo` or `~/morndo` (a prune would also drop the owner's own stale worktree entries), no other tmux server, not kira, not `~/.claude/settings.json`.

The PC and control plane blocks start with `mine`, which refuses (and exits 1, removing and killing nothing) unless `$QA/.created-by-fleet-qa` holds this run's ID, and they stop processes only through `stop_ours`: the pid must be running and its working directory under `$QAR` (`$QA` with links resolved). A recycled PID is never killed.

**C-1 Save the evidence first.** Run on the Mac. The PC's half runs only if the owner's go-ahead is on file:

```sh
. /tmp/morndo-qa-vars.sh
scp -r "$CP:morndo-qa/evidence" "$EVID/cp"
if grep -qx 'go-ahead: yes' "$EVID/pc-00-go-ahead.txt" 2>/dev/null; then scp -r "$PC_WSL:morndo-qa/evidence" "$EVID/pc"; else echo "PC part skipped: no go-ahead"; fi
ls -R "$EVID" | head -50
```

**C-2 PC (needs the go-ahead line, PC-0).** Run on the Mac. Without the line `go-ahead: yes` in `$EVID/pc-00-go-ahead.txt` it prints `PC part skipped: no go-ahead` and opens no connection to the PC:

```sh
. /tmp/morndo-qa-vars.sh
mkdir -p "$EVID/pc"
if ! grep -qx 'go-ahead: yes' "$EVID/pc-00-go-ahead.txt" 2>/dev/null; then echo "PC part skipped: no go-ahead"; else
ssh "$PC_WSL" bash -s <<'EOS' 2>&1 | tee "$EVID/pc/pc-cleanup.txt"
. ~/morndo-qa.vars.sh
mine                                                       # exits unless $QA is this run's
before=$(cut -d' ' -f1 "$QA/settings.sha256"); live_before=$(cat "$QA/evidence/pc-01-live.txt")
stop_ours "$QA/pc-agent.pid"; sleep 2
TT kill-server 2>/dev/null || true
cd "$HOME"
rm -rf "$QA" ~/morndo-qa.vars.sh /tmp/pc-01-preflight.txt /tmp/pc-01-settings.sha256 /tmp/pc-01-live.txt
after=$(sha256sum ~/.claude/settings.json | cut -d' ' -f1)
{ ss -ltn | grep -E ':(18787|18791)\b' || echo "18787, 18791 free"
  TT ls 2>&1 | head -1
  for f in "$HOME/morndo-qa" "$HOME/morndo-qa.vars.sh"; do test -e "$f" && echo "STILL THERE: $f" || echo "gone: $f"; done
  if [ "$before" = "$after" ]; then echo "settings.json unchanged: PASS"; else echo "settings.json CHANGED: FAIL"; fi
  if [ "$(live)" = "$live_before" ]; then echo "8787 listeners unchanged: PASS"; else echo "8787 listeners CHANGED: FAIL"; fi
  left=""; for d in /proc/[0-9]*; do case "$(readlink "$d/cwd" 2>/dev/null)" in "$QAR"|"$QAR"/*) left="$left ${d#/proc/}";; esac; done
  echo "processes still in $QA:${left:- none}"; }
EOS
fi
```

Expect:
- `18787, 18791 free` (the Mac's tunnel goes in C-3; if 18791 still shows, run C-3 and check again);
- `no server running on …/morndo-test`;
- `gone: …/morndo-qa` and `gone: …/morndo-qa.vars.sh`;
- `settings.json unchanged: PASS` (a `CHANGED: FAIL` is a stop: tell the owner at once);
- `8787 listeners unchanged: PASS` (kira untouched);
- `processes still in …/morndo-qa: none`.

**C-3 Mac tunnels.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
stop_tunnel /tmp/morndo-qa-tunnel-pc.pid; stop_tunnel /tmp/morndo-qa-tunnel-cp.pid
rm -f /tmp/morndo-qa-tunnel-pc.pid /tmp/morndo-qa-tunnel-cp.pid
lsof -nP -iTCP:18790 -sTCP:LISTEN; lsof -nP -iTCP:28791 -sTCP:LISTEN; echo "tunnels closed"
```

**C-4 Control plane.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh
mine                                                       # exits unless $QA is this run's
cd "$HOME"
for f in cp-agent hub fleet; do stop_ours "$QA/$f.pid"; done; sleep 2
TQ kill-server 2>/dev/null || true
git -C ~/morndo worktree remove --force "$REPO"          # this runbook's worktree, by its path; never a prune
if [ -n "${HUB_HOME:-}" ]; then case "$HUB_HOME" in /tmp/morndo-qa-hub-*) rm -rf "$HUB_HOME";; *) echo "REFUSED to remove HUB_HOME=$HUB_HOME";; esac; fi
rm -rf "$QA" ~/morndo-qa.vars.sh /tmp/cp-01-preflight.txt /tmp/cp-01-live.txt
{ ss -ltn | grep -E ':(18787|18790|18791)\b' || echo "18787, 18790, 18791 free"
  TQ ls 2>&1 | head -1; git -C ~/morndo worktree list
  for f in "$HOME/morndo-qa" "$HOME/morndo-qa.vars.sh" "${HUB_HOME:-/tmp/morndo-qa-hub-none}"; do test -e "$f" && echo "STILL THERE: $f" || echo "gone: $f"; done
  left=""; for d in /proc/[0-9]*; do case "$(readlink "$d/cwd" 2>/dev/null)" in "$QAR"|"$QAR"/*) left="$left ${d#/proc/}";; esac; done
  echo "processes still in $QA:${left:- none}"; } 2>&1 | tee /tmp/cp-cleanup.txt
```

(The leftover check looks at each process's working directory under `$QA`, which `/proc` still shows after the directory is gone. It doesn't match its own shell, and it can't match the command line of the ssh that carries this block, which `pgrep -f` would.)

Expect:
- the ports free;
- `no server running` (for `morndo-qa`);
- the worktree list without `morndo-qa/repo`, and otherwise as it was (CP-1's `git status` line is the main worktree; no other entry changed);
- `gone:` for each of the three paths;
- `processes still in …/morndo-qa: none`.

Then run on the Mac: `. /tmp/morndo-qa-vars.sh; scp "$CP:/tmp/cp-cleanup.txt" "$EVID/cp/" && ssh "$CP" rm /tmp/cp-cleanup.txt`.

**C-5 Mac.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
git -C ~/Projects/morndo worktree remove --force "$MACREPO"     # by its path; never a prune
git -C ~/Projects/morndo worktree list
```

Expect: no `/tmp/morndo-qa-mac`, and the other entries as before. `$EVID` and `/tmp/morndo-qa-vars.sh` stay until the record below is committed; delete them afterwards with `rm -rf /tmp/morndo-qa-evidence /tmp/morndo-qa-vars.sh`.

## 5. The record

Write `qa/<YYYY-MM-DD>-fleet-core.md` in the shape of the earlier QA records (a private QA record, not in this tree):
- the branch and revision, the hosts, Node and tmux versions, and the owner's go-ahead (his words and the time);
- a "How it was checked" table: CI (the run's link: `ci` and `fleet` jobs, `e2e fleet-two-node`) and this runbook (manual, the agent at the keys);
- the table below, each row with yes/no and the decisive output line, quoted from the evidence files;
- what the QA found, and what changed because of it (or "nothing").

Copy the screenshots to `qa/img-fleet/`. Look at each one before committing: it must show what its row claims. Copy no `.txt` file into the repo that holds a secret; the blocks above redact join strings and never print the cookie.

| Done criterion 3 (spec section 12) | Evidence |
|---|---|
| The hub lists both nodes | `img-fleet/pc-05-hub-both-nodes.png`, `pc/pc-05-both-nodes.txt` |
| A send | `img-fleet/cp-07-send.png`, `img-fleet/pc-06-send.png`, `cp/cp-07-submitted.txt`, `pc/pc-06-submitted.txt` (once each) |
| A frame | `img-fleet/cp-07-frame.png`, `img-fleet/pc-06-frame.png` |
| The drop-after-paste drill | `cp/cp-08-drop-after-paste.txt` (`409 uncertain`, then `200 duplicate`, `typed: 1`), `img-fleet/cp-08-drop-drill.png` |
| The tmux-restart drill | `pc/pc-07-*.txt` (the old and new ID, `404 no_pane`, "the new pane received nothing"), `img-fleet/pc-07-after-restart.png` |
| Section 9's control: stopping the PC test agent marks only its lanes offline | `cp/pc-08-offline.txt` (pc-test offline, cp online, `409 node_offline` to pc-scratch, `200` to cp-scratch, the alerts), `img-fleet/pc-08-pc-offline.png` (the offline marker on pc-scratch only) |
| Nothing live touched | `pc/pc-01-preflight.txt` and `pc/pc-cleanup.txt`: the same `settings.json` hash, 8787 listening before and after, no `morndo-test` server and no `~/morndo-qa` left; `cp/cp-cleanup.txt` |
