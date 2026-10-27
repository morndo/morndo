# The rehearsal kit (docs/plans/2026-10-24-c4-5-rehearsal.md step 4, docs/plans/2026-10-27-c4-resume.md §3)

Build the image and start a machine: `docker build -t morndo-rehearsal:c4-5 scripts/release/rehearsal/`, then
`docker compose -f scripts/release/rehearsal/compose.yaml up -d cp1` (cp2 and cp3 need `--profile p7` or `--profile p8`
before `up`). Before anything runs in it: `docker inspect c4-rehearsal-cp1-1 >c.json; docker network inspect
c4-rehearsal_net >n.json; sh scripts/release/rehearsal/check-container.sh c.json n.json`.
Hand the machine the bench's feed, as its worker: `docker exec -i -u worker -e XDG_RUNTIME_DIR=/run/user/1000
c4-rehearsal-cp1-1 sh -s "$feed" <scripts/release/rehearsal/env.sh` (`docker cp` cannot write into the tmpfs `/tmp`).
After `docker compose -f scripts/release/rehearsal/compose.yaml --profile p7 --profile p8 down`: `docker ps -a --filter
label=morndo-c4-rehearsal` and `docker network ls --filter label=morndo-c4-rehearsal` must print no machine and no network.
