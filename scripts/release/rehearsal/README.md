# The rehearsal kit (docs/plans/2026-10-24-c4-5-rehearsal.md step 4, docs/plans/2026-10-27-c4-resume.md §3)

Build the image and start a machine: `docker build -t morndo-rehearsal:c4-5 scripts/release/rehearsal/`, then
`docker compose -f scripts/release/rehearsal/compose.yaml up -d cp1` (cp2, cp3 need `--profile p7`, `--profile p8`).
Before anything runs in it: `docker inspect c4-rehearsal-cp1-1 >c.json; docker inspect c4-rehearsal_net >n.json; sh scripts/release/rehearsal/check-container.sh c.json n.json`.
Hand the machine the bench's feed: `docker compose -f scripts/release/rehearsal/compose.yaml exec -T cp1 sh -s "$feed" <scripts/release/rehearsal/env.sh`.
After `docker compose -f scripts/release/rehearsal/compose.yaml down --profile p7 --profile p8`: `docker ps -a --filter label=morndo-c4-rehearsal`
and `docker network ls --filter label=morndo-c4-rehearsal` must print no machine and no network.
