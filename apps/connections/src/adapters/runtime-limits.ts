// Runtime flags checked 2026-10-10.
// Claude Code sends apiKeyHelper stdout as both Authorization and x-api-key, and caches it for five minutes
// unless CLAUDE_CODE_API_KEY_HELPER_TTL_MS is set:
// https://code.claude.com/docs/en/llm-gateway-connect
// https://code.claude.com/docs/en/env-vars
// The launcher sets the TTL to 60s. N is 4 calls in that window: the refresh plus three retries.
// The next call ends the lease (CN9). The gateway page does not publish a retry count; this allowance is the measurement.
export const HELPER_TTL_MS = 60_000;
export const HELPER_LIMIT = 4;

// Codex auth.command timeout_ms example is 5000; refresh_interval_ms defaults to 300000. The launcher sets 60000.
// https://developers.openai.com/codex/config-advanced
export const CODEX_AUTH_TIMEOUT_MS = 5_000;
