# The rehearsal kit (docs/plans/2026-10-24-c4-5-rehearsal.md step 4, docs/plans/2026-10-27-c4-resume.md §3)

Build the image and start a machine: `docker build -t morndo-rehearsal:c4-5 scripts/release/rehearsal/`, then
`docker compose -f scripts/release/rehearsal/compose.yaml up -d cp1` (cp2 and cp3 need `--profile p7` or `--profile p8`
before `up`). Before anything runs in a machine: `docker network inspect c4-rehearsal_net >n.json` and
`docker image inspect morndo-rehearsal:c4-5 >i.json` once, then for each machine its inspect and the fence check:
`docker inspect c4-rehearsal-cp1-1 >cp1.json` with `sh scripts/release/rehearsal/check-container.sh cp1.json n.json i.json`,
`docker inspect c4-rehearsal-cp2-1 >cp2.json` with `sh scripts/release/rehearsal/check-container.sh cp2.json n.json i.json`,
`docker inspect c4-rehearsal-cp3-1 >cp3.json` with `sh scripts/release/rehearsal/check-container.sh cp3.json n.json i.json`.
Hand the machine the bench's feed, as its worker: `docker exec -i -u worker -e XDG_RUNTIME_DIR=/run/user/1000
c4-rehearsal-cp1-1 sh -s "$feed" <scripts/release/rehearsal/env.sh` (`docker cp` cannot write into the tmpfs `/tmp`).
After `docker compose -f scripts/release/rehearsal/compose.yaml --profile p7 --profile p8 down -v --remove-orphans`:
`docker ps -a --filter label=morndo-c4-rehearsal` and `docker network ls --filter label=morndo-c4-rehearsal` must print
no machine and no network; no prune command — this project only.
