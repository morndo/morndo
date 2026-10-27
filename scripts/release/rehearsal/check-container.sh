#!/bin/sh
# check-container.sh <container-inspect.json> <network-inspect.json> <image-inspect.json> -- the release
# rehearsal's fence check (docs/plans/2026-10-24-c4-5-rehearsal.md, step 4): the `docker inspect` output of one
# rehearsal machine, of its network and of the image it is to run (docker image inspect morndo-rehearsal:c4-5),
# each saved to a file, and every way that machine reaches past the rehearsal's fence becomes one FAIL line on
# stdout, all of them, in a fixed order: privilege (or an inspect that does not say), a capability beyond
# SYS_ADMIN, AUDIT_WRITE kept, devices, device cgroup rules, requested devices (DeviceRequests), anything of the
# host mounted in (binds, volumes, the docker socket), a network mode, or attached networks, that are not the
# rehearsal's own bridge alone, a host or another container's namespace, a cgroup namespace that is not private,
# a cgroup parent outside Docker's own, a missing memory, CPU or pids limit, published ports, security options,
# a missing rehearsal label, an e2e sweep's label (another lane's e2e
# run would remove the machine mid-rehearsal), a hostname outside rehearsal.test (a top-level domain the IETF
# reserves, RFC 6761 §6.2), an environment variable other than container and PATH (a token or an agent socket
# would otherwise come through the container; the value is never printed), a missing container=docker, an image
# other than morndo-rehearsal:c4-5, a container running a different image id than the inspected one, an
# inspected image without that tag, or with an e2e sweep's label, or without the rehearsal's label. With any
# FAIL line the last line is the count and the exit status is 1; with none, one ok line and status 0. Capability
# names are compared without their CAP_ prefix, upper-cased; an empty or missing list prints as none; image ids
# print as their first 19 characters. Read-only: three JSON files are read, nothing is written, nothing is
# started. jq comes from the caller's PATH. The field shapes are Docker Engine 29.8.1's and Compose 5.5.1's (a
# create-only probe and the inspect of a started machine, 2026-10-27).
set -eu
LC_ALL=C
export LC_ALL

name=check-container

fail() { # fail <message>: the message on stderr, status 1
  printf '%s: %s\n' "$name" "$*" >&2
  exit 1
}

if [ $# -ne 3 ]; then
  printf '%s: usage: check-container.sh <container-inspect.json> <network-inspect.json> <image-inspect.json>\n' "$name" >&2
  exit 64
fi

container=$1
network=$2
image=$3

# Each file must hold exactly one docker inspect object, as `docker inspect <one thing> >file` writes it: a JSON
# array of length one whose element is an object. Anything else — empty, not JSON, two objects — is refused
# before a single rule runs, so a half-written file can never look like a clean machine.
inspect_of_one='type == "array" and length == 1 and (.[0] | type == "object")'
jq -e "$inspect_of_one" "$container" >/dev/null 2>&1 ||
  fail "$container is not the docker inspect of one container"
jq -e "$inspect_of_one" "$network" >/dev/null 2>&1 ||
  fail "$network is not the docker inspect of one network"
jq -e "$inspect_of_one" "$image" >/dev/null 2>&1 ||
  fail "$image is not the docker inspect of one image"

# One FAIL line per broken rule, in the order of the header comment. A missing field and an empty one are the same
# thing (// [] and // {}): docker inspect omits what was never set rather than writing null for it.
rules='
def caps($l): ($l // []) | map(sub("^CAP_"; "") | ascii_upcase);
def joined($l): (caps($l) | join(",")) as $j | if $j == "" then "none" else $j end;
($containers[0][0]) as $c | ($networks[0][0]) as $n | ($images[0][0]) as $i |
(if $c.HostConfig.Privileged == null then "FAIL: the inspect does not say whether the container is privileged"
 elif $c.HostConfig.Privileged == true then "FAIL: the container is privileged" else empty end),
(if caps($c.HostConfig.CapAdd) != ["SYS_ADMIN"] then "FAIL: CapAdd is \(joined($c.HostConfig.CapAdd)), not exactly SYS_ADMIN" else empty end),
(if caps($c.HostConfig.CapDrop) != ["AUDIT_WRITE"] then "FAIL: CapDrop is \(joined($c.HostConfig.CapDrop)), not exactly AUDIT_WRITE" else empty end),
(if (($c.HostConfig.Devices // []) | length) > 0 then "FAIL: the container has devices" else empty end),
(if (($c.HostConfig.DeviceCgroupRules // []) | length) > 0 then "FAIL: the container has device cgroup rules" else empty end),
(if (($c.HostConfig.DeviceRequests // []) | length) > 0 then "FAIL: the container requests devices (DeviceRequests)" else empty end),
(if (($c.HostConfig.Binds // []) | length) > 0 or (($c.HostConfig.Mounts // []) | length) > 0 then "FAIL: the container has bind mounts" else empty end),
(($c.Mounts // [])[] | select(.Type != "tmpfs") | "FAIL: the container mounts \(.Source) (\(.Type))"),
(if $c.HostConfig.NetworkMode != $n.Name then "FAIL: the network mode is \($c.HostConfig.NetworkMode), not the rehearsal network \($n.Name)" else empty end),
((($c.NetworkSettings.Networks // {}) | keys) as $attached
  | if $attached != [$n.Name]
    then "FAIL: the container is attached to \(if ($attached | length) == 0 then "none" else ($attached | join(",")) end), not only the rehearsal network \($n.Name)"
    else empty end),
(if $n.Driver != "bridge" then "FAIL: the network \($n.Name) is not a bridge (driver \($n.Driver))" else empty end),
(if ($n.Labels // {})["morndo-c4-rehearsal"] != "1" then "FAIL: the network \($n.Name) lacks the label morndo-c4-rehearsal=1" else empty end),
(("PidMode", "IpcMode", "UTSMode", "UsernsMode") as $f
  | ($c.HostConfig[$f] // "") as $v
  | select($v == "host" or ($v | startswith("container:")))
  | "FAIL: \($f) is \($v)"),
(if $c.HostConfig.CgroupnsMode != "private" then "FAIL: CgroupnsMode is \($c.HostConfig.CgroupnsMode), not private" else empty end),
(if (($c.HostConfig.CgroupParent // "") | length) > 0 then "FAIL: CgroupParent is \($c.HostConfig.CgroupParent) (a machine stays in Docker'\''s own cgroup)" else empty end),
(if (($c.HostConfig.Memory // 0) <= 0) then "FAIL: the container has no memory limit" else empty end),
(if (($c.HostConfig.NanoCpus // 0) <= 0) then "FAIL: the container has no CPU limit" else empty end),
(if (($c.HostConfig.PidsLimit // 0) <= 0) then "FAIL: the container has no pids limit" else empty end),
(if (($c.HostConfig.PortBindings // {}) | length) > 0
  or $c.HostConfig.PublishAllPorts == true
  or (($c.NetworkSettings.Ports // {}) | [.[]? | select(. != null)] | length) > 0
then "FAIL: ports are published" else empty end),
(if (($c.HostConfig.SecurityOpt // []) | length) > 0 then "FAIL: SecurityOpt is set (\(($c.HostConfig.SecurityOpt // []) | join(",")))" else empty end),
(if ($c.Config.Labels // {})["morndo-c4-rehearsal"] != "1" then "FAIL: the container lacks the label morndo-c4-rehearsal=1" else empty end),
(if ($c.Config.Labels // {}) | has("morndo-c2-e2e") then "FAIL: the container carries the label morndo-c2-e2e, which an e2e sweep removes" else empty end),
(if ($c.Config.Labels // {}) | has("morndo-c3-fleet-e2e") then "FAIL: the container carries the label morndo-c3-fleet-e2e, which an e2e sweep removes" else empty end),
(if (($c.Config.Hostname // "") | endswith(".rehearsal.test") | not) then "FAIL: the hostname \($c.Config.Hostname) is not under rehearsal.test" else empty end),
(($c.Config.Env // [])[] | select(type == "string") | split("=")[0]
  | select(. != "container" and . != "PATH")
  | "FAIL: the container'\''s environment sets \(.) (only container and PATH may come through the container)"),
(if (($c.Config.Env // []) | index("container=docker")) == null then "FAIL: the container'\''s environment lacks container=docker" else empty end),
(if $c.Config.Image != "morndo-rehearsal:c4-5" then "FAIL: the image is \($c.Config.Image), not morndo-rehearsal:c4-5" else empty end),
(if $c.Image != $i.Id
  then "FAIL: the container runs image \($c.Image | .[0:19]), not morndo-rehearsal:c4-5'\''s \($i.Id | .[0:19])"
  else empty end),
(if (($i.RepoTags // []) | index("morndo-rehearsal:c4-5")) == null then "FAIL: the image inspected is not tagged morndo-rehearsal:c4-5" else empty end),
(if ($i.Config.Labels // {}) | has("morndo-c2-e2e") then "FAIL: the image carries the label morndo-c2-e2e, which an e2e sweep removes" else empty end),
(if ($i.Config.Labels // {}) | has("morndo-c3-fleet-e2e") then "FAIL: the image carries the label morndo-c3-fleet-e2e, which an e2e sweep removes" else empty end),
(if ($i.Config.Labels // {})["morndo-c4-rehearsal"] != "1" then "FAIL: the image lacks the label morndo-c4-rehearsal=1" else empty end)'

problems=$(jq -n -r --slurpfile containers "$container" --slurpfile networks "$network" --slurpfile images "$image" "$rules" 2>/dev/null) ||
  fail "$container, $network and $image could not be checked"

if [ -n "$problems" ]; then
  printf '%s\n' "$problems"
  count=$(printf '%s\n' "$problems" | grep -c '^FAIL:')
  printf '%s: %s problem(s)\n' "$name" "$count"
  exit 1
fi

cname=$(jq -r '.[0].Name | ltrimstr("/")' "$container")
nname=$(jq -r '.[0].Name' "$network")
printf '%s: ok (%s on %s: not privileged, CapAdd SYS_ADMIN, CapDrop AUDIT_WRITE, no devices, no mounts but tmpfs, no published ports)\n' \
  "$name" "$cname" "$nname"
