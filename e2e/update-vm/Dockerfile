# The throwaway machine of design §13's end-to-end run (e2e/update.e2e.ts): a whole systemd in a container, a
# user manager for a user of its own, and nothing of the host. The label marks everything this run makes, so the
# harness can assert it cleaned up after itself (docker ps -a --filter label=morndo-c2-e2e). SIGRTMIN+3 is
# systemd's own signal to shut down cleanly (systemd(1), "SIGRTMIN+3 (SIGRTMIN+4)").
FROM ubuntu:24.04

# systemd wants a few packages to behave like a machine: systemd itself, dbus-user-session so the user manager
# has its bus (the agent's tmux hosting and every systemctl --user the updater runs need it), tmux for the agent,
# sqlite3 for the scenario's database checks, ca-certificates for anything that leaves the machine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends systemd systemd-sysv dbus-user-session tmux sqlite3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The user everything runs as: uid 1000, a home of its own, and lingering on from the start (§5: the services
# must survive the login session that installed them — install refuses without it). The base image already
# spends uid 1000 on its own `ubuntu` user, so that one is renamed into worker rather than the uid fought over.
RUN usermod --login worker --home /srv/worker --move-home ubuntu \
  && groupmod --new-name worker ubuntu \
  && mkdir -p /var/lib/systemd/linger \
  && touch /var/lib/systemd/linger/worker

LABEL morndo-c2-e2e=1
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
