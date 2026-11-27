import { describe, expect, it } from "vitest";
import { readGoalAsk, type TopicFact } from "../src/goal-ask.ts";
import { World } from "../src/world.ts";

// The sentences here are not the ones the locked checks send; topics, numbers and wordings are made up.
const NOW = "2026-11-16T08:45:00+01:00";
const euro = (amountMinor: number) => ({ kind: "money" as const, money: { amountMinor, currency: "EUR" }, cap: null });
const count = (value: number, unit: string | null = null) => ({ kind: "count" as const, value, of: null, unit });
const rate = (percent: number) => ({ kind: "rate" as const, percent, standard: false });

const FACTS: TopicFact[] = [
  {
    id: "atlas", name: "Atlas", rank: 1, cap: { amountMinor: 2000, currency: "EUR" },
    goal: {
      target: 20, unit: "Signed deals", deadlineAt: "2027-03-31T17:00:00+02:00",
      guardrails: [
        { id: "atlas-refunds", what: "Refunds", limit: count(5, "per week") },
        { id: "atlas-spend", what: "Daily spend", limit: euro(15000) },
        { id: "atlas-churn", what: "Churn", limit: rate(3) },
      ],
    },
  },
  {
    id: "beacon", name: "Beacon", rank: 2, cap: { amountMinor: 9000, currency: "EUR" },
    goal: { target: 8, unit: "Pilot sites", deadlineAt: null, guardrails: [{ id: "beacon-refunds", what: "Refunds", limit: count(2, "per week") }] },
  },
  { id: "cobalt", name: "Cobalt", rank: 3, cap: { amountMinor: 1000, currency: "EUR" }, goal: null },
];
const read = (text: string, chat: string | null = "atlas", topics: readonly TopicFact[] = FACTS) => readGoalAsk(text, topics, chat, NOW, 3);
const brief = (ask: ReturnType<typeof read>) => ask && [ask.field, ask.topicId, ask.to, ask.unit, ask.deadlineAt?.slice(0, 10) ?? null];

describe("the goal ask grammar", () => {
  it("reads a sentence of each shape for each field", () => {
    expect(brief(read("Set the Beacon budget to €125 a week"))).toEqual(["budget", "beacon", 12500, null, null]);
    expect(read("Set the Beacon budget to €125 a week")?.budget?.period).toBe("week");
    expect(read("Set the Beacon budget to €125 a month")).toBeNull();
    expect(read("Set the Beacon budget to €5 a day")).toBeNull();
    expect(brief(read("Give Atlas a budget of 1.250,50 euros"))).toEqual(["budget", "atlas", 125050, null, null]);
    expect(brief(read("Budget for Beacon: 2k EUR per week please"))?.[2]).toBe(200000);
    expect(brief(read("Raise the Atlas target to 35"))).toEqual(["target", "atlas", 35, null, null]);
    expect(brief(read("The Beacon goal is now 9 pilot sites"))).toEqual(["target", "beacon", 9, null, null]);
    expect(brief(read("Move the Atlas deadline to 12 May"))).toEqual(["deadline", "atlas", 20, null, "2027-05-12"]);
    expect(brief(read("Set the Beacon goal to 11 sites by 3 March 2027"))?.slice(0, 3)).toEqual(["target", "beacon", 11]);
    expect(brief(read("Make Beacon the top priority"))).toEqual(["priority", "beacon", 1, null, null]);
    expect(brief(read("Put Atlas below Beacon in priority"))).toBeNull();
    expect(brief(read("Give Atlas a lower priority than Beacon"))).toEqual(["priority", "atlas", 2, null, null]);
    expect(brief(read("Set the refunds guardrail to 8"))).toEqual(["guardrail", "atlas", 8, null, null]);
    expect(brief(read("Set the churn guardrail to 4.5 percent"))?.[2]).toBe(5);
  });

  it("computes a relative amount from the current value, and only where the shape says by", () => {
    expect(brief(read("Cut the Atlas budget by €5 a week"))?.[2]).toBe(1500);
    expect(brief(read("Raise the Atlas target by 4 deals"))).toEqual(["target", "atlas", 24, null, null]);
    expect(brief(read("Lower the refunds guardrail by 2"))?.[2]).toBe(3);
    expect(read("Set the Atlas budget by €5")).toBeNull();
    expect(read("Tighten the Atlas budget by €5")).toBeNull();
    expect(read("Lower the refunds guardrail by 9")).toBeNull();
  });

  it("asks back when one word is left over, or a number, a topic, a negation or a clause comes first", () => {
    const base = "Set the Atlas target to 40";
    expect(read(base)).not.toBeNull();
    for (const text of [
      `${base} next quarter`, `${base} instead of 30`, `${base} unless Beacon slips`, `${base}, not more than 50`, `${base} except in March`,
      `${base} and the Beacon one to 12`, `${base} if we can`, `Do not ${base.toLowerCase()}`, `We should maybe ${base.toLowerCase()}`,
      `After May, ${base.toLowerCase()}`, `Ask Beacon whether to ${base.toLowerCase()}`, "Set the Atlas target to 40 or 41", "Set the Atlas target to 40 for Beacon",
      "Set the Atlas target to 40 deals too", "Set the Atlas target to 4 0", "Raise the Atlas target to 1 deals a month",
    ]) expect([text, read(text)]).toEqual([text, null]);
  });

  it("uses only readable topics and allows budget and priority changes on capped topics without a goal", () => {
    expect(read("Set the Beacon budget to €60 a week", "atlas", FACTS.filter(topic => topic.id !== "beacon"))).toBeNull();
    expect(read("Make Beacon the top priority", "atlas", FACTS.filter(topic => topic.id !== "beacon"))).toBeNull();
    expect(brief(read("Set the Cobalt budget to €60 a week"))).toEqual(["budget", "cobalt", 6000, null, null]);
    expect(brief(read("Make Cobalt the top priority"))).toEqual(["priority", "cobalt", 1, null, null]);
    expect(read("Set the target to 12", "cobalt")).toBeNull();
    expect(brief(read("Set the target to 12", "beacon"))).toEqual(["target", "beacon", 12, null, null]);
  });

  it("finds a guardrail by all the words of its name, in the named or the chat's topic first", () => {
    expect(brief(read("Set the refunds guardrail to 9", "beacon"))).toEqual(["guardrail", "beacon", 9, null, null]);
    expect(brief(read("Set the Atlas refunds guardrail to 9", "beacon"))).toEqual(["guardrail", "atlas", 9, null, null]);
    expect(read("Set the refund guardrail to 9", null)).toBeNull();
    expect(brief(read("Set the daily spend guardrail to €210", null))).toEqual(["guardrail", "atlas", 21000, null, null]);
    expect(read("Set the spend guardrail to €210", null)).toBeNull();
    expect(read("Set the Beacon daily spend guardrail to €210")).toBeNull();
    expect(read("Set the daily spend guardrail to €210 a day")).toBeNull();
  });

  it("asks back for a malformed number or a percentage over 100", () => {
    expect(read("Set the Atlas budget to €12,34,56")).toBeNull();
    expect(read("Set the refunds guardrail to 300%")).toBeNull();
  });

  it("takes a unit only when it is the goal's own or a plain new one", () => {
    expect(read("Set the Atlas target to 30 deals")?.unit).toBeNull();
    expect(read("Set the Atlas target to 30 signed deals")?.unit).toBeNull();
    expect(read("Set the Atlas target to 30 contracts")).toBeNull();
    expect(read("Set the Atlas target to 30 via referrals")).toBeNull();
    expect(read("Set the Atlas target to 2 hundred deals")).toBeNull();
    expect(read("Set the Atlas target to 30 qualified deals")?.unit).toBe("qualified deals");
    expect(read("Set the Atlas target to 30 this quarter")).toBeNull();
    expect(read("Set the Atlas target to 30 for December")).toBeNull();
  });

  it("ranks by number, ordinal, top, relation and one step", () => {
    expect(brief(read("Make Beacon our third priority"))?.[2]).toBe(3);
    expect(brief(read("Set the Beacon priority to number 1"))?.[2]).toBe(1);
    expect(brief(read("Raise the priority of Beacon"))?.[2]).toBe(1);
    expect(brief(read("Lower the priority of Atlas"))?.[2]).toBe(2);
    expect(brief(read("Prioritise Cobalt over Atlas"))).toEqual(["priority", "cobalt", 1, null, null]);
    expect(read("Make Beacon priority number 7")).toBeNull();
    expect(read("Raise the priority of Atlas")).toBeNull();
    expect(read("Move Beacon up two places in priority")).toBeNull();
  });
});

describe("what the stand-in does with a proposal", () => {
  const query = new URLSearchParams();
  const fresh = () => {
    const world = new World("gtm");
    const read = (definition: string, id = "") => world.read(definition, id, query, world.owner) as any;
    const send = (threadId: string, text: string) => world.act({ type: "message.send", threadId, text }) as any;
    const propose = (topic: string, text: string) => {
      const id = send(`topic:${topic}`, text).message.decisionId as string | null;
      expect(id, text).toBeTruthy();
      return id as string;
    };
    const act = (command: Record<string, unknown>) => world.act(command as never) as any;
    return { world, read, send, propose, act };
  };

  it("applies approvals in the order they were given, for a budget, a target and a guardrail, and undoes the one that remains", () => {
    const { read, propose, act } = fresh();
    const cases: [string, (n: number) => string, () => number | undefined][] = [
      ["seo", n => `Set the SEO budget to €${n} a week`, () => read("TopicView", "seo").spend.cap.amountMinor / 100],
      ["outbound", n => `Set the Outbound target to ${n}`, () => read("TopicView", "outbound").goal.target],
      ["outbound", n => `Set the sends a day guardrail to ${n}`, () => read("TopicView", "outbound").goal.guardrails.items.find((item: any) => item.id === "outbound-sends-a-day").limit.value],
    ];
    for (const [topic, text, value] of cases) {
      const start = value();
      const [early, late] = [propose(topic, text(47)), propose(topic, text(83))];
      act({ type: "decision.approve", decisionId: late });
      const last = act({ type: "decision.approve", decisionId: early });
      expect(value()).toBe(47);
      expect(last.events).toContainEqual({ type: "thread.changed", threadId: "manager" });
      const undone = act({ type: "decision.undo", decisionId: early });
      expect(value()).toBe(83);
      expect(undone.events).toContainEqual({ type: "thread.changed", threadId: "manager" });
      act({ type: "decision.undo", decisionId: late });
      expect(value()).toBe(start);
    }
  });

  it("puts the topic approved last first when two ask for the top priority, and keeps the ranks 1 to n", () => {
    const { read, propose, act } = fresh();
    const [content, outbound] = [propose("content", "Make Content the top priority"), propose("outbound", "Make Outbound the top priority")];
    act({ type: "decision.approve", decisionId: outbound });
    act({ type: "decision.approve", decisionId: content });
    const ranks = ["content", "outbound", "partnerships", "paid", "seo", "research"].map(id => read("TopicView", id).meta.priority);
    expect(ranks.slice(0, 2)).toEqual([1, 2]);
    expect([...ranks].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("computes a guardrail's state in one place, also for a limit of 0, and says when a command breaches it", () => {
    const { read, propose, act } = fresh();
    const item = () => read("TopicView", "outbound").goal.guardrails.items.find((entry: any) => entry.id === "outbound-spam-complaints");
    const spam = () => read("TopicView", "outbound").goal;
    expect(item().state).toBe("held");
    const sends = propose("outbound", "Set the sends a day guardrail to 0");
    const approved = act({ type: "decision.approve", decisionId: sends });
    expect(approved.events).toContainEqual({ type: "guardrail.breached", topicId: "outbound", name: "Sends a day", guardrailId: "outbound-sends-a-day" });
    const goal = spam();
    expect(goal.guardrails.items.find((entry: any) => entry.id === "outbound-sends-a-day").state).toBe("breached");
    expect(goal.blockers.some((blocker: any) => blocker.guardrailId === "outbound-sends-a-day")).toBe(true);
    // a limit of 0 with a reading of 0 holds
    expect(item().state).toBe("held");
    expect(goal.blockers.some((blocker: any) => blocker.guardrailId === "outbound-spam-complaints")).toBe(false);
  });

  it("changes only the number of a switch's limit, and says so, and moves the weekly cap with the agents-this-week limit", () => {
    const { read, propose, act } = fresh();
    const limit = () => read("SkillsView").guardrails.find((entry: any) => entry.id === "outbound").limit;
    const before = limit();
    const approved = act({ type: "decision.approve", decisionId: propose("outbound", "Set the sends a day guardrail to 38") });
    expect(limit()).toEqual({ ...before, value: 38, of: 38 });
    expect(approved.events).toContainEqual({ type: "skills.changed" });
    const undone = act({ type: "decision.undo", decisionId: approved.events.find((event: any) => event.type === "decision.changed").decisionId });
    expect(limit()).toEqual(before);
    expect(undone.events).toContainEqual({ type: "skills.changed" });

    const weekly = propose("seo", "Set the agents this week guardrail to €27");
    act({ type: "decision.approve", decisionId: weekly });
    const seo = read("TopicView", "seo");
    expect(seo.spend.cap.amountMinor).toBe(2700);
    expect(seo.goal.guardrails.items.find((entry: any) => entry.id === "seo-agents-this-week").limit.money.amountMinor).toBe(2700);
  });

  it("stores a forecast once, when the approval happens, and takes it back on Undo", async () => {
    const { read, propose, act } = fresh();
    const log = () => read("TopicView", "paid").goal.forecastLog as any[];
    const start = log().length;
    const id = propose("paid", "Set the Paid target to 2000");
    act({ type: "decision.approve", decisionId: id });
    const [first] = log().slice(start);
    expect(log()).toHaveLength(start + 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(log().at(-1)).toEqual(first);
    expect(first.scoreAt.slice(0, 10)).toBe("2026-12-31");
    expect(read("TopicView", "paid").goal.nextScoreAt).not.toBeNull();
    act({ type: "decision.undo", decisionId: id });
    expect(log()).toHaveLength(start);
  });

  it("splits a single sentence of two verb clauses, and nothing else", () => {
    const { act } = fresh();
    const filed = (text: string) => (act({ type: "lane.file", text }).events as any[]).filter(event => event.type === "lane.filed").length;
    expect(filed("Interview the three churned customers and proofread the pricing page")).toBe(2);
    expect(filed("Collect a list of event sponsors and translate our onboarding email")).toBe(2);
    expect(filed("Interview the three churned customers and proofread them")).toBe(1);
    expect(filed("Collect the sponsor list, and translate the onboarding email")).toBe(1);
    expect(filed("Collect the sponsor list. Translate the onboarding email and proofread the footer")).toBe(1);
    expect(filed("Collect the sponsor list and translate the onboarding email and proofread the footer")).toBe(1);
    expect(filed("Check the red and blue banners")).toBe(1);
    expect(filed("Invite the speakers to the call and remind the ones who have not replied")).toBe(1);
  });
});
