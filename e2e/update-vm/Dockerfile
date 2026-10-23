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

# Without --privileged, Docker mounts the container's (private) cgroup tree read-only, and systemd as PID 1 cannot
# make its own scopes. The container has CAP_SYS_ADMIN (systemd.io/CONTAINER_INTERFACE: "do not drop" it), so the
# entrypoint remounts that tree writable — its own namespace's, nothing of the host's — and becomes /sbin/init.
# A host whose security profile forbids the remount (AppArmor's docker-default denies mount) gets one clear line and
# exit 77 here, which the harness reads at once, rather than a systemd that never comes up.
RUN printf '#!/bin/sh\nif ! mount -o remount,rw /sys/fs/cgroup 2>/tmp/e2e-init.err; then\n  echo "e2e-init: cannot remount /sys/fs/cgroup writable ($(cat /tmp/e2e-init.err)); this host forbids it (AppArmor?)"\n  exit 77\nfi\nexec /sbin/init\n' > /usr/local/sbin/e2e-init \
  && chmod 0755 /usr/local/sbin/e2e-init

LABEL morndo-c2-e2e=1
STOPSIGNAL SIGRTMIN+3
CMD ["/usr/local/sbin/e2e-init"]
