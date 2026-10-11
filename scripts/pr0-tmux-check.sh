#!/bin/sh
# Throwaway systemd container. The agent, not this script, starts the first lane.
# One run hosts tmux in a user scope; the next sets MORNDO_TMUX_NO_SCOPE=1.
# Removes the container when it finishes. Does not use this machine's user manager.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
NAME=morndo-pr0-tmux
NODE_VER=v24.21.0
if [ "${1-}" ]; then
  OUT=$1
  mkdir -p "$(dirname "$OUT")"
else
  OUT="$(mktemp -d)/pr0-tmux-check.txt"
fi
docker rm -f "$NAME" >/dev/null 2>&1 || true
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$NAME" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$ROOT:/src:ro" \
  jrei/systemd-ubuntu:24.04
i=0
while [ "$i" -lt 40 ]; do
  state=$(docker exec "$NAME" systemctl is-system-running 2>/dev/null || true)
  case "$state" in running|degraded) break ;; esac
  i=$((i + 1))
  sleep 1
done
docker exec -i "$NAME" bash -s -- "$NODE_VER" <<'EOS' >"$OUT" 2>&1
set -eu
NODE_VER=$1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tmux curl ca-certificates xz-utils sudo >/dev/null
curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz" -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
printf '%s\n' '#!/bin/sh' 'exec sleep 600' > /usr/local/bin/claude
chmod 755 /usr/local/bin/claude
node --version
CHECK_HOME=/srv/morndo-check
id -u morndo >/dev/null 2>&1 || useradd --create-home --home-dir "$CHECK_HOME" --shell /bin/bash morndo
loginctl enable-linger morndo
UIDN=$(id -u morndo)
systemctl start "user@${UIDN}.service"
install -d -o morndo -g morndo -m 700 "/run/user/${UIDN}" $CHECK_HOME/work $CHECK_HOME/.config/morndo-node $CHECK_HOME/.config/systemd/user
chown -R morndo:morndo $CHECK_HOME/.config $CHECK_HOME/work
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if [ -S "/run/user/${UIDN}/bus" ]; then break; fi
  sleep 1
done
asuser() { sudo -u morndo env HOME=$CHECK_HOME XDG_RUNTIME_DIR="/run/user/${UIDN}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${UIDN}/bus" "$@"; }
NODE="node --experimental-strip-types"
FLEET="/src/apps/fleet/src/main.ts"
AGENT="/src/apps/node-agent/src/main.ts"
SOCK=$CHECK_HOME/.local/state/morndo-fleet/fleet.sock

cat > $CHECK_HOME/.config/morndo-node/policy.json <<'JSON'
{ "tmuxSocket": "pr0", "session": "main" }
JSON
chown morndo:morndo $CHECK_HOME/.config/morndo-node/policy.json

UNITDIR=$CHECK_HOME/.config/systemd/user
cat > "$UNITDIR/morndo-fleet.service" <<UNIT
[Unit]
Description=Morndo fleet (pr0 check)
[Service]
ExecStart=/usr/local/bin/${NODE} ${FLEET} serve
Restart=no
Environment=HOME=$CHECK_HOME
Environment=XDG_RUNTIME_DIR=/run/user/${UIDN}
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${UIDN}/bus
UNIT
cat > "$UNITDIR/morndo-node.service" <<UNIT
[Unit]
Description=Morndo node agent (pr0 check)
[Service]
ExecStart=/usr/local/bin/${NODE} ${AGENT} run
KillMode=control-group
Restart=no
Environment=HOME=$CHECK_HOME
Environment=XDG_RUNTIME_DIR=/run/user/${UIDN}
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${UIDN}/bus
StandardOutput=append:$CHECK_HOME/node.log
StandardError=append:$CHECK_HOME/node.log
UNIT
: > $CHECK_HOME/node.log
chown morndo:morndo $CHECK_HOME/node.log
chown -R morndo:morndo "$UNITDIR"
asuser systemctl --user daemon-reload
asuser systemctl --user start morndo-fleet.service
n=0
while [ "$n" -lt 20 ] && [ ! -S "$SOCK" ]; do n=$((n + 1)); sleep 1; done
test -S "$SOCK"
JOIN=$(asuser ${NODE} ${FLEET} node add node-1 | awk '/^morndo-join:1:/ { print; exit }')
test -n "$JOIN"
asuser ${NODE} ${AGENT} join "$JOIN"
# No tmux server yet. The agent creates the first lane itself.
if asuser tmux -u -L pr0 has-session 2>/dev/null; then echo "RESULT setup: a tmux server already existed"; exit 1; fi

cat > /tmp/pr0-post-lane.mjs <<JS
import { request } from "node:http";
const body = JSON.stringify({ node: "node-1", op: "lane.start", args: { name: process.argv[2], cwd: "$CHECK_HOME/work" }, key: process.argv[3], timeoutMs: 20000 });
const req = request({ socketPath: process.argv[4], path: "/v1/op", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, res => {
  const chunks = [];
  res.on("data", c => chunks.push(c));
  res.on("end", () => { process.stdout.write(String(res.statusCode) + " " + Buffer.concat(chunks).toString("utf8") + "\\n"); process.exit(res.statusCode === 200 ? 0 : 1); });
});
req.on("error", e => { console.error(e); process.exit(1); });
req.end(body);
JS
cat > /tmp/pr0-online.mjs <<JS
import { request } from "node:http";
const req = request({ socketPath: process.argv[2], path: "/v1/nodes", method: "GET" }, res => {
  const chunks = [];
  res.on("data", c => chunks.push(c));
  res.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    process.stdout.write(body + "\\n");
    process.exit(body.includes('"status":"online"') ? 0 : 1);
  });
});
req.on("error", () => process.exit(1));
req.end();
JS
post_lane() { asuser node /tmp/pr0-post-lane.mjs "$1" "$2" "$SOCK"; }
wait_online() {
  n=0
  while [ "$n" -lt 30 ]; do
    if asuser node /tmp/pr0-online.mjs "$SOCK"; then return 0; fi
    n=$((n + 1))
    sleep 1
  done
  return 1
}

echo "===== scoped run ====="
asuser systemctl --user start morndo-node.service
if ! wait_online; then
  echo "=== agent journal ==="
  asuser journalctl --user -u morndo-node.service --no-pager -n 80 || true
  echo "RESULT scoped: node did not come online"
  exit 1
fi
echo "=== lane.start ==="
post_lane kept "lanes:pr0"
echo "=== systemctl status ==="
asuser systemctl --user status morndo-node.service --no-pager || true
echo "=== scopes ==="
asuser systemctl --user list-units --type=scope --all --no-pager || true
echo "=== systemd-cgls ==="
systemd-cgls --no-pager || true
SERVER=$(ps -u morndo -o pid=,args= | awk '/tmux/ && !/tmux -u -L pr0 (display-message|has-session|list-sessions)/ { print $1; exit }')
echo "tmux server pid ${SERVER:-missing}"
if [ -n "${SERVER:-}" ]; then echo "server cgroup: $(cat /proc/$SERVER/cgroup)"; fi
AGENT=$(asuser systemctl --user show morndo-node.service -p MainPID --value)
echo "agent pid $AGENT"
echo "agent cgroup: $(cat /proc/$AGENT/cgroup)"
case "$(cat /proc/${SERVER:-0}/cgroup 2>/dev/null || true)" in
  *run-*.scope*) echo "RESULT scoped-cgroup: server is in a user scope" ;;
  *morndo-node.service*) echo "RESULT scoped-cgroup: server is inside the agent unit" ;;
  *) echo "RESULT scoped-cgroup: server cgroup is neither a scope nor the agent unit" ;;
esac
echo "=== node log ==="
cat $CHECK_HOME/node.log || true
if ! asuser systemctl --user list-units --type=scope --all --no-pager | grep -q 'run-.*\.scope'; then
  echo "=== agent journal ==="
  journalctl --no-pager -n 80 _SYSTEMD_USER_UNIT=morndo-node.service || true
  asuser journalctl --user -u morndo-node.service --no-pager -n 80 || true
fi
echo "=== stop the agent ==="
asuser systemctl --user stop morndo-node.service
sleep 1
if asuser tmux -u -L pr0 has-session -t =main; then echo "RESULT scoped-stop: panes still running"; else echo "RESULT scoped-stop: panes died"; fi

echo "===== control run (MORNDO_TMUX_NO_SCOPE=1) ====="
asuser tmux -u -L pr0 kill-server || true
sleep 1
mkdir -p "$UNITDIR/morndo-node.service.d"
cat > "$UNITDIR/morndo-node.service.d/no-scope.conf" <<'CONF'
[Service]
Environment=MORNDO_TMUX_NO_SCOPE=1
CONF
chown -R morndo:morndo "$UNITDIR/morndo-node.service.d"
asuser systemctl --user daemon-reload
asuser systemctl --user start morndo-node.service
if ! wait_online; then
  echo "=== agent journal ==="
  asuser journalctl --user -u morndo-node.service --no-pager -n 80 || true
  echo "RESULT control: node did not come online"
  exit 1
fi
echo "=== lane.start ==="
post_lane plain "lanes:pr1"
echo "=== systemd-cgls ==="
systemd-cgls --no-pager || true
CSERVER=$(ps -u morndo -o pid=,args= | awk '/tmux/ && !/display-message|has-session/ { print $1; exit }')
echo "control server pid ${CSERVER:-missing}"
if [ -n "${CSERVER:-}" ]; then echo "control cgroup: $(cat /proc/$CSERVER/cgroup)"; fi
echo "=== stop the agent ==="
asuser systemctl --user stop morndo-node.service
sleep 1
if asuser tmux -u -L pr0 has-session -t =main; then echo "RESULT control-stop: panes still running"; else echo "RESULT control-stop: panes died"; fi
EOS
echo "wrote $OUT"
