# The worker socket and reaching it from another machine

The fleet's client API has two Unix sockets in the same directory (`docs/fleet-api.md` §1):

- `fleet.sock`, the owner's: every route, for the clients that run beside the fleet (the hub, `lanes`, kira).
- `fleet-worker.sock`, the worker's: the same routes, narrowed (the table in `fleet-api.md` §1). This is the one to give to a machine that reaches the fleet through a forward.

The worker socket has a fixed path, `workerSocket.path` in the fleet's config, by default `fleet-worker.sock` beside `socketPath` (`~/.local/state/morndo-fleet/fleet-worker.sock`). It is created with mode 0600 in the same 0700 directory.

## Why a command-bound key, not a port forward

OpenSSH can allow or refuse a socket forward as a kind, but cannot limit it to one path. A key that may forward can therefore reach any socket its user can open, the owner's among them. A key that is bound to a command cannot: `command=` runs that one command whatever the client asks for, and `restrict` turns off forwarding, agent, X11 and a pty (sshd(8) of OpenSSH 9.6, "AUTHORIZED_KEYS FILE FORMAT", read 2026-10-24). So the remote machine gets a key whose only effect is to connect its stdin and stdout to the worker socket.

## On the control plane: the key

One line in `~/.ssh/authorized_keys` of the fleet's user (a key made only for this, with no passphrase if a service uses it):

```
restrict,command="socat STDIO UNIX-CONNECT:<HOME>/.local/state/morndo-fleet/fleet-worker.sock" ssh-ed25519 AAAA… fleet-link
```

`<HOME>` is the fleet user's home as an absolute path (sshd does not expand `~` in the command). If the config names another `workerSocket.path`, use that path. The command the client sends is ignored, so a connection can only ever reach this socket. Add `from="<address list>"` before `restrict` to also limit where the key may be used from. `socat` is `socat STDIO UNIX-CONNECT:<file>` (socat(1) 1.8.0.0, `UNIX-CONNECT`, `UNIX-LISTEN` and `EXEC`, read 2026-10-24).

## On the other machine: a local socket that runs one ssh per connection

A socat listener makes a socket path for the local clients; each connection to it starts one `ssh` that the forced command answers. A user service:

```
[Unit]
Description=Fleet worker socket, forwarded

[Service]
ExecStart=/usr/bin/socat UNIX-LISTEN:%t/fleet-worker.sock,fork,mode=0600,unlink-early EXEC:'ssh -T -o BatchMode=yes -o IdentitiesOnly=yes -i %h/.ssh/fleet-link <user>@<control-plane host>'
Restart=on-failure

[Install]
WantedBy=default.target
```

The clients there point at `$XDG_RUNTIME_DIR/fleet-worker.sock` (`MORNDO_FLEET_SOCKET` for the hub console's `lanes`). `-T` asks for no pty, as the forced command needs an 8-bit clean channel. The events stream is a WebSocket upgrade over the same HTTP connection, so it needs nothing more.

## What the remote machine can do

Only what the worker socket allows. With `workerSocket.startNodes` empty (the default) it can look, peek at any pane, type into and deliver to any lane that is not protected, stop such a lane, and cancel jobs; it cannot start a lane or a worktree, type into or deliver to a protected lane (by default the sticky lanes and the lane events' recipient), revoke a node, move a Rollout, change a connection's policy, or push memory. Name the nodes it may place work on:

```json
{ "workerSocket": { "startNodes": ["pc", "edge"] } }
```

Every refusal is a row in the fleet's audit table with actor `worker` and action `refused`; it is not an Alert.

## What this does not stop

A process of the fleet's own user can still open the owner socket; this narrows what a forward carries, not what the user can do on the machine. The worker scope trusts the fleet's view of the lanes: a pane that no node has yet listed is refused for typing, and a lane is protected by its name as the inventory reports it.
