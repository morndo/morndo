# PR 6: subscriptions through the gate

Login, the stripped environment and the auth-method check are in the three runtime adapters. The week of live lanes through the gate is not this PR. Switch one provider at a time, after that week, with the command below. Each switch saves the provider's current command and does not overwrite that save if it is run again.

## Switch on

```
morndo-keys gate on claude
morndo-keys gate on codex
morndo-keys gate on cursor
```

The new command is `morndo-keys run --connection <name> --`. The probe is `morndo-keys check --connection <name>`.

## Rollback

```
morndo-keys gate off claude
morndo-keys gate off codex
morndo-keys gate off cursor
```

Rollback restores the bin and probe saved at switch-on. That saved command is whatever the provider had then.
