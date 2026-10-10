# Agent instructions

This tree is published. Follow these rules on every change:

- No QA screenshots, recordings, or evidence notes in the repo.
- Demo data, fixtures, and tests use made-up names, hosts, paths, ids, and quotes.
- No real names, machine names, home directories, or private chat.
- No secrets, tokens, or key files.
- Run the pre-push hook (`sh scripts/install-git-hooks.sh` once per clone). It runs gitleaks and checks the commits being pushed for home paths, private keys, and tokens. Extra patterns can live outside the tree; see `CONTRIBUTING.md`.

Human contributors use `CONTRIBUTING.md`. How the public repo is set up is `docs/public-repo.md`.
