import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

const BASE = "/api/cockpit";

async function boot(module: "gtm" | "dev"): Promise<{ url: string; stop: () => Promise<void> }> {
  const child: ChildProcess = spawn(process.execPath, ["apps/cockpit-standin/src/main.ts", "--module", module, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line: ${out.slice(0, 300)}`)), 15000);
    const read = (chunk: Buffer) => {
      out += chunk.toString();
      const found = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (!found?.[1]) return;
      clearTimeout(timer);
      resolve(Number(found[1]));
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`stand-in exited ${code}: ${out.slice(0, 300)}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      child.kill();
    }),
  };
}

async function get(url: string, path: string): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(url + BASE + path);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function act(url: string, command: unknown, as?: string): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(url + BASE + "/actions" + (as ? `?as=${as}` : ""), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function decisionId(body: Record<string, any>): string {
  const event = (body.events ?? []).find((item: { type?: string }) => item.type === "decision.changed");
  if (!event?.decisionId) throw new Error("no decision was opened");
  return event.decisionId as string;
}

describe("behaviours the locked check does not send", () => {
  it("lowers a priority, parses other money, and opens a guardrail that is not cost per lead", async () => {
    const { url, stop } = await boot("gtm");
    try {
      const lowered = await act(url, { type: "message.send", threadId: "topic:paid", text: "Lower the priority of Paid for now" });
      expect(lowered.status).toBe(200);
      const priority = (await get(url, `/decisions/${decisionId(lowered.body)}`)).body.goalChange;
      expect(priority.field).toBe("priority");
      expect(priority.priority.to).toBe(priority.priority.from + 1);
      expect(priority.priority.to).not.toBe(1);

      const euros = await act(url, { type: "message.send", threadId: "topic:paid", text: "Raise the Paid budget cap to €8,000 a month" });
      expect(euros.status).toBe(200);
      const budget = (await get(url, `/decisions/${decisionId(euros.body)}`)).body.goalChange;
      expect(budget.budget.to.amountMinor).toBe(800000);
      expect(budget.budget.period).toBe("a month");
      expect(euros.body.message.text).toContain("€8,000");

      const guardrail = await act(url, { type: "message.send", threadId: "topic:outbound", text: "Raise the outbound guardrail to 80 emails a day" });
      expect(guardrail.status).toBe(200);
      const limit = (await get(url, `/decisions/${decisionId(guardrail.body)}`)).body.goalChange;
      expect(limit.guardrail.name).toBe("Sends a day");
      expect(limit.guardrail.to.value).toBe(80);

      const top = await act(url, { type: "message.send", threadId: "manager", text: "Outbound should be our top priority for the rest of the month" });
      expect(top.status).toBe(200);
      const ranked = (await get(url, `/decisions/${decisionId(top.body)}`)).body;
      expect(ranked.topicId).toBe("outbound");
      expect(ranked.goalChange.priority.to).toBe(1);
      const replies = (top.body.events ?? []).map((event: { message?: { text?: string } }) => event.message?.text ?? "");
      expect(replies.some((text: string) => text.includes("until you approve it"))).toBe(true);
    } finally {
      await stop();
    }
  });

  it("moves an approved guardrail, target and budget into the topic, the brief and the manager asks", async () => {
    const { url, stop } = await boot("gtm");
    try {
      const asked = await act(url, { type: "message.send", threadId: "topic:paid", text: "Increase the cost per lead guardrail to 120 euros" });
      const id = decisionId(asked.body);
      expect((await act(url, { type: "decision.approve", decisionId: id })).status).toBe(200);
      const paid = (await get(url, "/topics/paid")).body;
      const blocker = paid.goal.blockers.find((item: { guardrailId?: string }) => item.guardrailId === "cost-per-lead");
      expect(blocker.short).toContain("€120");
      expect(blocker.short).not.toContain("€100");
      expect(paid.goal.verdict.word).not.toBe("Over cost");

      const target = await act(url, { type: "message.send", threadId: "topic:outbound", text: "Raise the Outbound target to 90" });
      expect((await act(url, { type: "decision.approve", decisionId: decisionId(target.body) })).status).toBe(200);
      const outbound = (await get(url, "/topics/outbound")).body;
      expect(outbound.goal.target).toBe(90);
      expect(outbound.goal.verdict.word).toBe("Behind plan");

      const before = (await get(url, "/brief")).body.spend.cap.amountMinor as number;
      const budget = await act(url, { type: "message.send", threadId: "topic:paid", text: "Raise the budget for Paid to 2000 euros a week" });
      const change = (await get(url, `/decisions/${decisionId(budget.body)}`)).body.goalChange;
      expect(change.budget.period).toBe("a week");
      expect(change.affectedTopics).not.toContain("paid");
      const asks = (await get(url, "/manager")).body.asks as { quote?: string; went?: string }[];
      expect(asks.some(item => item.quote === "Raise the budget for Paid to 2000 euros a week" && item.went === "a goal change · waits for you in Decide")).toBe(true);
      expect((await act(url, { type: "decision.approve", decisionId: decisionId(budget.body) })).status).toBe(200);
      expect((await get(url, "/brief")).body.spend.cap.amountMinor).toBe(before - 3000 + 200000);

      const deadline = await act(url, { type: "message.send", threadId: "topic:content", text: "Push the Content deadline back to 31 January" });
      const content = (await get(url, `/decisions/${decisionId(deadline.body)}`)).body.goalChange;
      expect(content.affectedTopics).not.toContain("content");
      expect(Array.isArray(content.affectedTopics)).toBe(true);
    } finally {
      await stop();
    }
  });

  it("refuses an expired undo and a sent-outside row that is not undoable", async () => {
    const { url, stop } = await boot("gtm");
    try {
      const overnight = (await get(url, "/brief")).body.overnight as { id: string; undoable: boolean; undoUntilAt: string }[];
      const expired = overnight.find(row => row.id === "o1");
      const sent = overnight.find(row => row.id === "o3");
      expect(expired).toMatchObject({ undoable: true });
      expect(Date.parse(expired?.undoUntilAt ?? "")).toBeLessThan(Date.parse("2026-11-16T08:45:00+01:00"));
      expect(sent).toMatchObject({ undoable: false });
      expect((await act(url, { type: "agentAction.undo", actionId: "o1" })).status).toBe(409);
      expect((await act(url, { type: "agentAction.undo", actionId: "o3" })).status).toBe(409);
    } finally {
      await stop();
    }
  });

  it("advances the mail quota and turn when wave 2 is sent", async () => {
    const { url, stop } = await boot("gtm");
    try {
      const sent = await act(url, { type: "lane.act", laneId: "outreach-wave-2", act: "send-wave-2" }, "lea-brandt");
      expect(sent.status).toBe(200);
      expect((sent.body.events ?? []).some((event: { type?: string; resourceId?: string }) => event.type === "resource.changed" && event.resourceId === "your-mail")).toBe(true);
      const mail = ((await get(url, "/manager")).body.sharedResources as { id?: string; turn?: string; quota?: { value?: number } }[])
        .find(item => item.id === "your-mail");
      expect(mail?.turn).toBe("outreach-wave-2");
      expect(mail?.quota?.value).toBe(38);
      const lane = (await get(url, "/lanes/outreach-wave-2")).body;
      expect(lane.stateWord).toBe("Working");
      expect(lane.next).toBe("Sent from your mail, 20 a day");
      expect(lane.steps.find((step: { text?: string }) => step.text?.includes("Lea checks"))?.kind).toBe("ok");
    } finally {
      await stop();
    }
  });

  it("keeps the server busy count inside its capacity and lets a finished lane free a seat", async () => {
    const { url, stop } = await boot("dev");
    try {
      const read = async () => (await get(url, "/skills")).body.connections.find((item: { id?: string }) => item.id === "your-server").capacity as { value: number; of: number };
      const before = await read();
      expect(before.value).toBeLessThan(before.of);
      const filed = await act(url, { type: "lane.file", topicId: "infra", text: "Rotate the staging database password" });
      expect(filed.status).toBe(200);
      expect((await read()).value).toBe(before.value + 1);
      expect((await act(url, { type: "lane.undoFile", laneId: filed.body.laneId })).status).toBe(200);
      expect((await read()).value).toBe(before.value);
      for (let index = 0; index < 8; index += 1) {
        expect((await act(url, { type: "lane.file", topicId: "web", text: `Note the spare capacity check ${index}` })).status).toBe(200);
      }
      const full = await read();
      expect(full.value).toBe(full.of);
      expect(full.value).toBeLessThanOrEqual(8);
    } finally {
      await stop();
    }
  });

  it("splits two deliverables that do not both start with the old verb list", async () => {
    const { url, stop } = await boot("gtm");
    try {
      const text = "Draft the Fenwick case study and update the pricing page FAQ";
      const filed = await act(url, { type: "lane.file", text });
      expect(filed.status).toBe(200);
      const ids = filed.body.receipt.groupLaneIds as string[];
      expect(ids).toHaveLength(2);
      const lanes = await Promise.all(ids.map(async id => (await get(url, `/lanes/${id}`)).body.title as string));
      expect(lanes[1]?.startsWith("Update")).toBe(true);
      const quotes = ((await get(url, "/manager")).body.asks as { quote?: string }[]).map(item => item.quote);
      expect(quotes).toContain(text);
      const single = await act(url, { type: "lane.file", text: "Write a recap of the webinar for the newsletter" });
      expect(single.body.receipt.groupLaneIds).toEqual([]);
    } finally {
      await stop();
    }
  });
});
