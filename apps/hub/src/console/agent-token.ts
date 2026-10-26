// One line of `morndo agent-token list`.
import type { AgentToken } from "../adapters/store.ts";

export const agentTokenLine = (t: AgentToken, when: (t: number | null) => string): string =>
  `${t.id}  ${t.name.padEnd(20)}  ${t.role.padEnd(7)}  ${[...t.scopes].join(",") || "-"}  made ${when(t.createdAt)}  last used ${when(t.lastUsedAt)}  ${t.revokedAt ? `REVOKED ${when(t.revokedAt)}` : "active"}${t.unboundCount > 0 ? `  unbound readings ${t.unboundCount}, last ${when(t.lastUnboundAt)}` : ""}`;

// What `agent-token new` says after it prints the secret. A usage-pool token belongs to a collector, which reads it
// from the tokenFile of its config; the lanes take theirs from MORNDO_AGENT_TOKEN.
export const agentTokenMade = (t: AgentToken, hub: string): string => {
  const where = t.scopes.includes("usage-pool")
    ? "put it in the collector's tokenFile (mode 600), not in MORNDO_AGENT_TOKEN"
    : `put it in MORNDO_AGENT_TOKEN for ${t.role === "manager" ? "the manager's lane" : "the worker lanes"}, with MORNDO_HUB=${hub}`;
  return `Token ${t.id} (${t.name}, ${t.role}${t.scopes.length > 0 ? `, ${[...t.scopes].join(", ")}` : ""}). Shown once: ${where}.`;
};
