# Trust files

Public keys and signatures the release pipeline reads (design: `docs/design/updates/README.md`, sections 9.6 and 11).
No private key is ever stored here.

| File | Holds | Read by |
|---|---|---|
| `release_allowed_signers` | the release public key, identity and namespace `release@morndo.github.io` | `release.yml` |
| `feed_allowed_signers` | the feed public key, identity and namespace `feed@morndo.github.io` | `release.yml`, `feed.yml` |
| `keys.json` | the key set, version 1: the fingerprints of the root, release and feed keys, valid until `expiresAt` | `release.yml` (its `version`) |
| `keys.json.sig` | root's signature over the exact bytes of `keys.json`, namespace `keys@morndo.github.io` | updaters, once they walk key sets |

## Signing `keys.json` (root key, owner only)

The root key signs only through the owner's password manager SSH agent. `keys.json.sig` is not in the tree until
then. Any edit to `keys.json` (its `expiresAt` included) makes an earlier signature invalid.

On the machine with the agent (point `SSH_AUTH_SOCK` at the agent's socket if it is not the default), from the
repository root:

```sh
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPjwqMc0uDQdQHelLxhebc5/oO2hpmEzFNQQuXX0UBUC' > /tmp/root.pub \
  && ssh-keygen -Y sign -f /tmp/root.pub -n keys@morndo.github.io trust/keys.json
```

This writes `trust/keys.json.sig`. Check it, then commit it:

```sh
echo 'root@morndo.github.io namespaces="keys@morndo.github.io" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPjwqMc0uDQdQHelLxhebc5/oO2hpmEzFNQQuXX0UBUC' > /tmp/root.allowed \
  && ssh-keygen -Y verify -f /tmp/root.allowed -I root@morndo.github.io -n keys@morndo.github.io -s trust/keys.json.sig < trust/keys.json
```

Fingerprints: root `SHA256:fWLNSJCecJxMS+aNFP8ZeAva4OYryNGWjEv9MC18pPo`, release
`SHA256:tW1KoCBd6Arcxk0zYai6d3qTQrgvnYgxOjYaY0qaGcA`, feed `SHA256:uYdDYvYfwq8lAkxt4Y8ZlqAv1YFGtCIF95NNTYWGl48`.
