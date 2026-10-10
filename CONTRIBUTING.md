# Contributing

Morndo is the control plane for one person running many coding agents. The open core is AGPLv3 (`LICENSE.md`). Anything under a directory named `ee` is the enterprise licence (`ee/LICENSE.md`).

## Local setup

Node must match `engines` in `package.json` (`.nvmrc` names the major). From a fresh checkout:

```sh
npm ci
npm test
npm run check
npm run lint
```

`npm test` is the unit and browser projects. `npm run check` is the type check, including the web app. A flow you can click also has a script under `e2e/`. The README's three commands are how to run the hub locally. No screenshot guide.

Install the leak hook once per clone. It does not change git config:

```sh
sh scripts/install-git-hooks.sh
```

The hook runs gitleaks, then checks the commits being pushed for absolute home paths (`/home/…`, `/Users/…`), private keys, and tokens. It also checks uncommitted and untracked files, and it does not scan itself. A new branch is limited to commits that are not on any remote; the first push of a repository checks the whole tree. Optional extra patterns, one regex per line, can live outside the tree at `$(git rev-parse --git-dir)/info/leak-patterns`; the hook reads that file when it is present. See `docs/public-repo.md`.

## Public-repo rules

- No QA screenshots, recordings, or evidence notes in the tree.
- Demo data, fixtures, and tests use made-up names, hosts, paths, ids, and quotes.
- No real names, machine names, home directories, or private chat.
- No secrets, tokens, or key files. A synthetic value that a scanner must keep needs an allowlist entry that names the exact path and rule.
- Run the pre-push hook before you push. CI runs the same scanner on every push and pull request.

## Pull requests

Say what changed and how you ran the checks above. Do not add a secret to prove a scanner.
