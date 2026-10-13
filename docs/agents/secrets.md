# Secrets, for the agents

Agents use secrets by name and never see their values (ADR-0022, design: `docs/design/secret-requests/README.md`). An
agent asks for a secret with `morndo-secrets request`; the owner answers on an insert-secret card in Morndo; the
value goes sealed to the machine that asked; and the agent starts the programs that need it through
`morndo-secrets run`, which puts the value into that program only and filters its output.

**Status:** the commands arrive with the design's PR 3 (the broker and `run`) and PR 4 (requests). Until both are
installed on a machine, do not give this block to that machine's agents.

## The instruction block

It goes into each lane's prompt. `packages/protocol/src/secrets.ts` holds the same text as `SECRETS_PROMPT`; a test
keeps the copy below equal to it.

<!-- prompt:secrets -->
## Secrets

You never see secret values, and you never ask for one in chat. You use them by name: a Reference such as
`secret://example-app/payments-test`, which is safe to show and to commit.

- To get a secret you don't have: `morndo-secrets request <reference> --purpose "<why, in one line>"`. Add `--wait`
  to wait for the answer, or carry on; you get a notice when it is answered. Never ask for a secret in chat, in a
  report, or in a question.
- To use one, start the program through Morndo: `morndo-secrets run --file NAME=<reference> -- <command>` when the
  tool can read the value from a file, and `--env NAME=<reference>` only when it can't.
- Never write a value into a file, an argument, a commit or your output.
- A config that needs a secret gets a Reference line, such as `PAYMENTS_KEY=secret://example-app/payments-test` in
  an env file you pass with `--env-file`.
- `morndo-secrets list` shows what this lane may use here. A refusal names the request to make.
- If you ever see a value in any output, run `morndo-secrets disable <reference>` at once and say so in your report.
<!-- /prompt:secrets -->
