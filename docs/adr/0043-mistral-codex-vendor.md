# ADR-0043: Mistral as a Codex-runtime vendor (GLM 5.3)

- **Status:** Accepted, 2026-11-07.
- **Number:** 0043. 0040, 0041 and 0042 are already records.
- **Builds on:** ADR-0018 (Connections, the vendor catalog, the lease gate), ADR-0028 (Codex as an engine).

## Context

Codex can call a Responses endpoint that is not OpenAI's. A probe on 2026-11-07 with Codex 0.163.0 ran `zai-glm-5-3` through `codex exec --json` against `https://api.mistral.ai/v1` with `wire_api = "responses"`, including tool calls. The same probe was refused for effort `medium` (the endpoint accepts `low`, `high` and `max`) and for Codex's hosted `web_search` tool (HTTP 400).

`turn.completed.usage` is `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}`. `cached_input_tokens` is part of `input_tokens` (one probe: 1,073,276 input, of which 1,052,992 cached). `output_tokens` includes reasoning.

Mistral's published prices for the GA models, USD per 1M tokens, read 2026-11-07: GLM 5.3 input 1.4, cached input 0.14, output 4.4; GLM 5.3 Flash 0.15, 0.03 and 0.5.

The Commercial Terms (effective 2026-09-25, §4.2) exclude training on customer data except for users who opt in. Mistral's help text of 2026-09-03 says Vibe plan usage is used for training until the user opts out in the plan's settings. The same help says data is hosted in the European Union by default.

A key Connection on the Codex runtime writes `[model_providers.morndo]` with the preset's base URL and an auth command. The gate's floor is the preset's isolation. Codex's isolation is whatever the permission profile gives, and a profile that sets none of the sandbox keys is read as `rules`. A floor of `os` would refuse every run on a node that has no permission profile. Spend for a non-Claude key run was the runtime's `total_cost_usd`, which Codex does not report, so the lease closed at the whole reservation.

## Decision

1. **Ship a `mistral` preset.** API key, Codex runtime, dialect `openai-responses`, base URL `https://api.mistral.ai/v1`. Static models `zai-glm-5-3` and `zai-glm-5-3-flash`. Family `zai`, the same family as Z.ai's own preset, because the models are Z.ai's and the other-provider review compares families. Spend is `token-price`, with the two price rows dated 2026-11-07. The default pick is `zai-glm-5-3@high`. Isolation floor is `rules`, the same floor as OpenAI. Terms revision `2026-09-25`, with the summary that hosting is in the EU by default, the commercial terms exclude training on customer data, and Vibe plan usage is used for training until opted out. Auto routing classes `*glm-5-3-flash*` as fast and `*glm-5-3*` as flagship, flash first so it wins.
2. **A Codex key run writes vendor root keys.** `web_search = "disabled"` unless the base URL's host is `api.openai.com`. `model_reasoning_effort` is the run plan's effort when that effort is non-empty (the preset's default pick when the caller named none). The lines sit after `model_provider` and before the profile, so they stay root keys, ahead of every table. A root key the profile already sets is left as the profile wrote it. An `-c model_reasoning_effort=...` on the Codex command line still wins at run time. Subscription runs do not get these lines.
3. **A Codex key run with catalog prices is charged from reported tokens.** Each `turn.completed` line costs `(input − cached) × input + cached × cache-read + output × output`, per 1M, at the catalog row for the model the argv names (`-m` or `--model`), or the plan's model when the argv names none. No completed turn, no price for that model, or a non-finite or negative count leaves the cost null, and the lease then keeps the fallback it already had. Claude and Cursor are unchanged.

## Alternatives

| Option | Verdict |
|---|---|
| **An `os` isolation floor** | Rejected. Codex reports `rules` when the profile sets no sandbox and no read-deny. `os` would refuse every key run on a node without a permission profile. OpenAI's own key preset is `rules` for the same reason. |
| **A user-file catalog overlay** | Rejected. A node can already add a preset in its own catalog file. Shipping this one keeps the endpoint, the prices, the terms and the isolation floor the same on every node, and the catalog tests can see them. |

## Consequences

- A Mistral key is added, checked and run like any other Codex key. The hosted web search tool is not offered, and the effort written for GLM 5.3 is one the endpoint accepts.
- A finished turn is charged the token price, including a run that fails after one or more turns have completed. A run that names a model the catalog has no price for keeps the previous fallback.
- The models share Z.ai's family, so the other-provider review treats Mistral-hosted GLM and Z.ai's own GLM as one family.
- Subscription Codex runs, the Claude and Cursor runtimes, key pools, the gate and every other preset are unchanged.

## Sources (read 2026-11-07)

- https://docs.mistral.ai/models/zai-glm-5-3 — GLM 5.3 prices
- https://docs.mistral.ai/models/zai-glm-5-3-flash — GLM 5.3 Flash prices
- https://help.mistral.ai/en/articles/455207 — Vibe plan usage is used for training until opted out (page dated 2026-09-03)
- https://help.mistral.ai/en/articles/347629 — data is hosted in the European Union by default
- https://legal.mistral.ai/terms/commercial-terms-of-service — Commercial Terms, effective 2026-09-25, §4.2
