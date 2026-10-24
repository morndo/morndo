// One line of `morndo agent-token list`.
import type { AgentToken } from "../adapters/store.ts";

export const agentTokenLine = (t: AgentToken, when: (t: number | null) => string): string =>
  `${t.id}  ${t.name.padEnd(20)}  ${t.role.padEnd(7)}  ${[...t.scopes].join(",") || "-"}  made ${when(t.createdAt)}  last used ${when(t.lastUsedAt)}  ${t.revokedAt ? `REVOKED ${when(t.revokedAt)}` : "active"}${t.unboundCount > 0 ? `  unbound readings ${t.unboundCount}, last ${when(t.lastUnboundAt)}` : ""}`;
