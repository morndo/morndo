import type { AccountsView, SignInView } from "@morndo/protocol";
import type { SignInRuntime } from "@morndo/domain";
import { api } from "$lib/api.ts";

export type SignInTarget = { node: string; runtime: SignInRuntime; account: string; create: boolean };

export type SignInCard = SignInTarget & { id: string };

export function signInCardId(c: SignInTarget): string {
  return `signin-${c.node}-${c.runtime}-${c.account}`;
}

export const signinApi = {
  nodes: () => api.get<{ nodes: string[] }>("/api/signins/nodes"),
  cards: () => api.get<{ cards: SignInCard[] }>("/api/signins/cards"),
  accounts: (node: string, runtime: SignInRuntime) => api.get<AccountsView>(`/api/signins/accounts?node=${encodeURIComponent(node)}&runtime=${runtime}`),
  start: (body: SignInTarget) => api.post<SignInView>("/api/signins", body),
  view: (id: string) => api.get<SignInView>(`/api/signins/${encodeURIComponent(id)}`),
  code: (id: string, sealed: string) => api.post<SignInView>(`/api/signins/${encodeURIComponent(id)}/code`, { sealed }),
  cancel: (id: string) => api.post<SignInView>(`/api/signins/${encodeURIComponent(id)}/cancel`, {}),
};
