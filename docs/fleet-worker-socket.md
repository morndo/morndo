# The worker socket and reaching it from another machine

The fleet's client API has two Unix sockets in the same directory (`docs/fleet-api.md` §1):

- `fleet.sock`, the owner's: every route, for the clients that run beside the fleet (the hub, `lanes`, kira).
- `fleet-worker.sock`, the worker's: the same routes, narrowed (the table in `fleet-api.md` §1). This is the one to give to a machine that reaches the fleet through a forward.

The worker socket has a fixed path, `workerSocket.path` in the fleet's config, by default `fleet-worker.sock` beside `socketPath` (`~/.local/state/morndo-fleet/fleet-worker.sock`). It is created with mode 0600 in the same 0700 directory.

## Why a command-bound key, not a port forward

OpenSSH can allow or refuse a socket forward as a kind, but cannot limit it to one path. A key that may forward can therefore reach any socket its user can open, the owner's among them. A key that is bound to a command cannot: `command=` runs that one command whatever the client asks for, and `restrict` turns off forwarding, agent, X11 and a pty (sshd(8) of OpenSSH 9.6, "AUTHORIZED_KEYS FILE FORMAT", read 2026-10-24). So the remote machine gets a key whose only effect is to connect its stdin and stdout to the worker socket.

## On the control plane: the key

One line in `~/.ssh/authorized_keys` of the fleet's user (a key made only for this; its private half sits on the other machine, readable by everything that runs there, so the line must also say where it may be used from):

```
from="<the other machine's addresses>",restrict,command="socat STDIO UNIX-CONNECT:<HOME>/.local/state/morndo-fleet/fleet-worker.sock" ssh-ed25519 AAAA… fleet-link
```

`from=` is required, not an extra: it limits the key to the other machine's addresses (sshd(8) `from="pattern-list"`), so a copy of the key elsewhere opens nothing. `<HOME>` is the fleet user's home as an absolute path (sshd does not expand `~` in the command). If the config names another `workerSocket.path`, use that path, with no colon, comma or space in it. The command the client sends is ignored, so a connection can only ever reach this socket. `socat` is `socat STDIO UNIX-CONNECT:<file>` (socat(1) 1.8.0.0, `UNIX-CONNECT`, `UNIX-LISTEN` and `EXEC`, read 2026-10-24).

## On the other machine: a local socket that runs one ssh per connection

A socat listener makes a socket path for the local clients; each connection to it starts one `ssh` that the forced command answers. A user service:

```
[Unit]
Description=Fleet worker socket, forwarded

[Service]
ExecStart=/usr/bin/socat UNIX-LISTEN:%t/fleet-worker.sock,fork,max-children=8,mode=0600,unlink-early EXEC:'ssh -T -o BatchMode=yes -o IdentitiesOnly=yes -o ClearAllForwardings=yes -o ControlPath=none -i %h/.ssh/fleet-link <user>@<control-plane-host>'
Restart=on-failure

[Install]
WantedBy=default.target
```

socat splits an address on `:`, so keep the `EXEC:` command line free of colons (a non-default ssh port or an IPv6 address goes in an `ssh_config` host alias, or in a small wrapper script that `EXEC:` runs). `max-children=8` keeps a flood of local connections from starting more than eight `ssh` processes at once (each one also counts against the control plane's `sshd` `MaxStartups` while it logs in); `ClearAllForwardings=yes` and `ControlPath=none` keep a user's own ssh configuration from adding forwards or sharing a connection to this one. The clients there point at `$XDG_RUNTIME_DIR/fleet-worker.sock` (`MORNDO_FLEET_SOCKET` for the hub console's `lanes`). `-T` asks for no pty, as the forced command needs an 8-bit clean channel. The events stream is a WebSocket upgrade over the same HTTP connection, so it needs nothing more.

## What the remote machine can do

Only what the worker socket allows (`fleet-api.md` §1). It can look (lanes, nodes, jobs, the events stream, inventories), peek at any pane that is not a protected lane's (what it is shown of a protected lane drops the topic, last prompt, title and session, and the session and stashed draft of its deliveries), and, on the nodes named in `workerSocket.startNodes` only, start and stop lanes and worktrees, type into and deliver to lanes that are not protected, upload and read files, and cancel jobs with the lane's token. With `startNodes` empty (the default) it can place and change nothing. It cannot, anywhere: touch a protected lane (by default the sticky lanes and the lane events' recipient; the file's `protectedLanes` adds to these and cannot remove them), read transcripts, set a job's notice, revoke a node, move a Rollout, change a connection's policy, or push memory. Name the nodes it may work on:

```json
{ "workerSocket": { "startNodes": ["pc", "edge"] } }
```

Every refusal is a row in the fleet's audit table with actor `worker` and action `refused`; it is not an Alert.

## What this does not stop

A process of the fleet's own user can still open the owner socket; this narrows what a forward carries, not what the user can do on the machine. The worker scope trusts the fleet's view of the lanes: a pane that no node has yet listed is refused, and a lane is protected by its name as the inventory reports it, and by its identity once the fleet has seen it under a protected name (its worker ID, session and working directories are remembered in the fleet's memory, and the lane registry's rows seed that memory when the fleet starts). A protected window renamed while the fleet was down, before it was ever seen under its name, is not recognised by identity; nothing can be written to it from the worker socket in any case, since its node is outside `startNodes` unless a protected lane runs on a start node.
