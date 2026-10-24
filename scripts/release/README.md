# Release scripts

The manifest's schema version and floor come from each app's `MIGRATIONS` array, the same rule the apps use when they migrate. Reading that array imports `@morndo/service-kit`, which loads `better-sqlite3`.

Run `npm ci` with the Node that will run these scripts before `manifest` or any command that builds a manifest. The release workflow does that in the build job. A `node_modules` tree installed by a different Node fails the schema read until `npm ci` is run again.

`schema-read.ts` starts that child with the repository as its working directory and no inherited Node flags. Node 24 strips TypeScript types by default, so none are required. A failure is reported as `schema read failed:` plus the child's own message. The Pages `feed-site` command does not load the apps and does not need `npm ci`.

## The release bench overlay

`sh scripts/release/bench-overlay.sh <commit> --version <x.y.z> --trust <dir> --root-signer <file> --out <dir> [--repo <dir>]` writes a local tree for the release bench. It archives `<commit>` from `--repo` (default: this repository) and applies the overlay. It never pushes and never talks to a network.

The four inputs are the source commit, the bench version (`x.y.z`), a trust directory that holds exactly the four bench trust files, and the bench root signer file. `--out` is where the tree is written.

`sh scripts/release/bench-overlay.sh --audit <commit> <out-dir> [--repo <dir>]` compares that tree with `git archive` of the commit and refuses a difference that is not part of the overlay.

`scripts/release/bench-overlay/removed-tests.txt` is data, one test path per line, for tests that pin a production value. `release.test.ts` is on it because three of its tests assert the seven-day promotion wait, which the overlay shortens to 20 minutes (found by running the whole `units` suite on an overlaid tree). Extend the list when a test starts failing in the bench's `units` job.
