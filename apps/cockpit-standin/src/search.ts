import type { Actor, Answer, Deal, LaneView as Lane, SearchResult, Skill, DecisionState, TopicView as Topic } from "@morndo/cockpit-api";
import { leadFor, type Route } from "./routes.ts";

const QUESTION = /^(where|what|how|who|when|why|which|is|are|does|did|do|can|should)\b/i;

export function isQuestion(text: string): boolean {
  return /\?\s*$/.test(text) || QUESTION.test(text.trim());
}

export function searchResults(query: string, scope: string, topics: Topic[], lanes: Lane[], people: { actor: Actor; topicId: string }[], decisions: { id: string; title: string; topicId: string; topicName: string; state: DecisionState; lead: Actor | null }[], skills: Skill[]): SearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const topicName = new Map(topics.map((topic) => [topic.id, topic.name]));
  const inScope = (topicId: string | null) => !scope || topicId === scope;
  const has = (value: string) => value.toLowerCase().includes(needle);
  const results: SearchResult[] = [];
  for (const topic of topics) {
    if (!inScope(topic.id) || !has(topic.name)) continue;
    const verdict = topic.goal?.verdict.word ?? "No goal set";
    results.push({ kind: "topic", id: topic.id, title: topic.name, sub: verdict, target: { kind: "topic", id: topic.id }, state: topic.health?.state ?? null, lead: null, topics: [] });
  }
  for (const lane of lanes) {
    if (!inScope(lane.topicId) || (!has(lane.title) && !has(lane.id) && !has(lane.lead.name))) continue;
    const name = lane.topicId ? topicName.get(lane.topicId) ?? "Manager" : "Manager";
    results.push({ kind: "lane", id: lane.id, title: lane.title, sub: `${name} · ${lane.stateWord}`, target: { kind: "lane", id: lane.id }, state: lane.state, lead: lane.lead, topics: lane.topicId ? [lane.topicId] : [] });
  }
  const seen = new Set<string>();
  for (const person of people) {
    if (seen.has(person.actor.id) || !inScope(person.topicId) || !has(person.actor.name)) continue;
    seen.add(person.actor.id);
    results.push({ kind: "person", id: person.actor.id, title: person.actor.name, sub: person.actor.role, target: { kind: "person", id: person.actor.id }, state: null, lead: null, topics: [...new Set(people.filter(item => item.actor.id === person.actor.id).map(item => item.topicId))] });
  }
  for (const decision of decisions) {
    if (!inScope(decision.topicId) || !has(decision.title)) continue;
    results.push({ kind: "decision", id: decision.id, title: decision.title, sub: decision.topicName, target: { kind: "decision", id: decision.id }, state: decision.state, lead: decision.lead, topics: [decision.topicId] });
  }
  if (!scope) {
    for (const skill of skills) {
      if (!has(skill.name) && !has(skill.summary)) continue;
      results.push({ kind: "skill", id: skill.id, title: skill.name, sub: skill.summary, target: { kind: "skill", id: skill.id }, state: null, lead: null, topics: [] });
    }
  }
  return results;
}

/** An answer from a deal, a lane, or a topic goal. Plain text, no markup. */
export function answerTo(query: string, scope: string | null, topics: Topic[], lanes: Lane[]): Answer | null {
  const text = query.toLowerCase();
  for (const topic of topics) {
    for (const deal of topic.goal?.deals ?? []) {
      const key = deal.name.split(/[ ,]/)[0]?.toLowerCase() ?? "";
      if (key.length > 3 && text.includes(key)) return dealAnswer(topic, deal);
    }
  }
  const lane = lanes.find((item) => item.title.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 4).some((word) => text.includes(word)));
  if (lane) {
    const topic = topics.find((item) => item.id === lane.topicId);
    return { text: `${lane.title}: ${lane.stateWord}. ${lane.status}`, source: `${topic?.name ?? "Manager"} · lane`, target: { kind: "lane", id: lane.id } };
  }
  const named = topics.find((topic) => text.includes(topic.name.toLowerCase())) ?? (scope ? topics.find((topic) => topic.id === scope) : undefined);
  if (named?.goal) {
    return { text: `${named.name}: ${named.goal.verdict.word}. ${named.goal.insight}`, source: `${named.name} · ${named.goal.asOf}`, target: { kind: "topic", id: named.id } };
  }
  return null;
}

function dealAnswer(topic: Topic, deal: Deal): Answer {
  const next = deal.next ? `Next: ${deal.next}` : deal.short;
  return { text: `${deal.name}: ${deal.stage}. ${next}`, source: `${topic.name} · ${deal.confidence}`, target: deal.target };
}

export function routePreview(text: string, topicParam: string | null, topics: Map<string, Topic>, routes: Route[]): { text: string; topicId: string | null; topicName: string | null; lead: Actor | null; chain: boolean } {
  const chain = /\b(then|once|after|before)\b/i.test(text);
  let topic: Topic | undefined;
  if (topicParam === "manager") return { text, topicId: null, topicName: null, lead: null, chain };
  if (topicParam) topic = topics.get(topicParam.replace(/^[ap]-/, ""));
  if (!topic) {
    const route = routes.find((item) => item.re.test(text));
    if (route) topic = topics.get(route.topicId);
  }
  if (!topic) return { text, topicId: null, topicName: null, lead: null, chain };
  const lead = leadFor(topic, text, routes) ?? null;
  return { text, topicId: topic.id, topicName: topic.name, lead, chain };
}
