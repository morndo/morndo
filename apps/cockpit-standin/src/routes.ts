/** Routing words copied from the mockups (gtm.blocks.html routes, dev.blocks.html routes). */

import type { Actor } from "./model.ts";

export interface Route {
  topicId: string;
  lead: string;
  re: RegExp;
}

export const GTM_ROUTES: Route[] = [
  { topicId: "partnerships", lead: "Brand scout", re: /partner|clay|apollo|halden|brightmoor|northvale|corvane/i },
  { topicId: "content", lead: "Writer", re: /webinar|visual|promo|post|carousel|image|recap|fenwick|story|quote/i },
  { topicId: "paid", lead: "Paid buyer", re: /\bsearch\b|budget|linkedin|\bads?\b|google|campaign/i },
  { topicId: "outbound", lead: "Sender", re: /sequence|email|\bleads?\b|outbound|fintech/i },
  { topicId: "seo", lead: "SEO writer", re: /\bseo\b|keyword|comparison|ranking/i },
  { topicId: "research", lead: "Researcher", re: /research|profile|competitor/i },
];

export const DEV_ROUTES: Route[] = [
  { topicId: "web", lead: "Builder", re: /\bmain\b|\bred\b|sign-?in|login|nightly|session|filter|\bnode\b|upgrade|dependenc/i },
  { topicId: "api", lead: "Builder", re: /export|time ?out|fenwick|chunk|\bapi\b|rate.?limit/i },
  { topicId: "billing", lead: "Builder", re: /\btax|billing|invoice|migration/i },
  { topicId: "mobile", lead: "Builder", re: /mobile|phone|\bscans?\b|offline/i },
  { topicId: "infra", lead: "Builder", re: /server|certificate|deploy|backup|staging/i },
];

const STOP = new Set(["with", "that", "this", "from", "have", "will", "them", "they", "what", "when", "next", "week", "more", "into", "about", "please", "their"]);

/** The topic agent whose work shares the most words with the ask, else the route's lead. */
export function leadFor(topic: { id: string; crew: Actor[] }, text: string, routes: Route[]): Actor | undefined {
  const words = (text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => !STOP.has(word));
  let best: Actor | undefined;
  let score = 0;
  for (const agent of topic.crew) {
    if (agent.kind === "person") continue;
    const hay = `${agent.name} ${agent.text ?? ""} ${agent.skill ?? ""}`.toLowerCase();
    const next = words.filter((word) => hay.includes(word.slice(0, 4))).length;
    if (next > score) {
      score = next;
      best = agent;
    }
  }
  if (best) return best;
  const route = routes.find((item) => item.topicId === topic.id);
  if (!route) return topic.crew.find((agent) => agent.kind === "agent") ?? topic.crew[0];
  return topic.crew.find((agent) => agent.name === route.lead) ?? topic.crew[0];
}
