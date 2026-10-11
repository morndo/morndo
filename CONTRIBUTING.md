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

Install the leak hook and the commit-message hook once per clone. Neither changes git config:

```sh
sh scripts/install-git-hooks.sh
```

The pre-push hook runs gitleaks, then checks every commit the push adds on its own — a plain commit through its own patch, a root commit against the empty tree, a merge commit through its combined diff against every parent, which holds only the conflict resolution — for absolute home paths (`/home/…`, `/Users/…`), private keys, and tokens in the lines that commit adds. Every match on an added line is checked. A search that fails aborts the push. A marker already in a file does not fail a later edit, and a line a later commit removes still fails in the commit that added it. A private-key header in a test or fixture file is a fixture. It also rejects a commit whose author or committer email is not at `users.noreply.github.com`. The hook checks only what the push adds: commits already on the remote you push to (its remote-tracking refs; fetch first) are not checked again, and there is no exception list. A push to a URL, or to a remote with no tracking refs, checks everything the remote tip does not already hold. It also checks uncommitted and untracked files, and it does not scan itself or `scripts/git-hooks/leak-allowlist`. A match on that list is ignored only when both the path and the exact text are listed; a different match in the same file still fails. Optional extra patterns, one regex per line, can live outside the tree at `$(git rev-parse --git-dir)/info/leak-patterns`; the hook reads that file when it is present. The commit-message hook rejects assistant attribution. See `docs/public-repo.md`.

## Public-repo rules

- No QA screenshots, recordings, or evidence notes in the tree.
- Demo data, fixtures, and tests use made-up names, hosts, paths, ids, and quotes.
- No real names, machine names, home directories, or private chat.
- No secrets, tokens, or key files. A synthetic value that a scanner must keep needs an allowlist entry that names the exact path and rule.
- Run the pre-push hook before you push. CI runs the same scanner on every push and pull request. The commit-message hook rejects assistant attribution; CI checks the same patterns on every pull request and on every push to `main`.

## Pull requests

Say what changed and how you ran the checks above. Do not add a secret to prove a scanner.
