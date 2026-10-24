# Security

## Supported versions

Security fixes go to the default branch. There are no versioned releases yet.

## Reporting a vulnerability

Report privately through GitHub, once private vulnerability reporting is enabled for this repository: open the Security tab and choose **Report a vulnerability**.

Do not open a public issue for a suspected vulnerability, and do not email a person. A report needs a summary, how to reproduce it, and what it affects. Maintainers reply on that private report.

## Verifying a release

```
release@morndo.github.io namespaces="release@morndo.github.io" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILGOA2QkwWhAgWf3mM3sUCqH38i9HiFRe84R7qadRdh7
```

```sh
ssh-keygen -Y verify -f morndo.allowed_signers -I release@morndo.github.io -n release@morndo.github.io -s install.sh.sig < install.sh
```

The key line is the same in the README; if they differ, do not install and report it as a vulnerability. Both copies come from this repository, so a match is not proof that the key is genuine: `gh attestation verify install.sh --repo morndo/morndo --signer-workflow morndo/morndo/.github/workflows/release.yml@refs/heads/main` is the independent check (`--signer-workflow` pins the release workflow on `main`; without it `gh` accepts an attestation made by any workflow of the repository), and for an install you rely on it is not optional.
