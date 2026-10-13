# Release scripts

The manifest's schema version and floor come from each app's `MIGRATIONS` array, the same rule the apps use when they migrate. Reading that array imports `@morndo/service-kit`, which loads `better-sqlite3`.

Run `npm ci` with the Node that will run these scripts before `manifest` or any command that builds a manifest. The release workflow does that in the build job. A `node_modules` tree installed by a different Node fails the schema read until `npm ci` is run again.

`schema-read.ts` starts that child with the repository as its working directory and the same Node flags as the parent. A failure is reported as `schema read failed:` plus the child's own message. The Pages `feed-site` command does not load the apps and does not need `npm ci`.
