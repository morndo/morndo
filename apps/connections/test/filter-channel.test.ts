// The channel a pooled run's helper uses to give the run's output filter a key before the agent is given it (ADR-0037, decision 18): the run listens on a
// private socket, the helper sends the key and waits for the answer, no answer means no key. The keys are synthetic.
import { createServer, connect } from "node:net";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sendToFilter, serveFilterChannel } from "../src/filter-channel.ts";

const KEY = "sk-ant-synthetic-channel-key-0001";
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
const serve = async (max?: number) => {
  const added: string[] = [];
  const channel = await serveFilterChannel({ add: keys => { added.push(...keys); }, ...(max === undefined ? {} : { max }) });
  closers.push(() => channel.close());
  return { channel, added };
};

describe("the filter channel", () => {
  it("adds the key to the filter before it answers, and the answer is yes", async () => {
    const { channel, added } = await serve();
    let seenAtAnswer: string[] = [];
    const ok = await sendToFilter(channel.path, KEY).then(result => { seenAtAnswer = [...added]; return result; });
    expect(ok).toBe(true);
    expect(seenAtAnswer).toEqual([KEY]);
  });

  it("lives in a private directory (0700) and is itself 0600", async () => {
    const { channel } = await serve();
    expect(statSync(dirname(channel.path)).mode & 0o777).toBe(0o700);
    expect(statSync(channel.path).mode & 0o777).toBe(0o600);
  });

  it("refuses an empty key, an oversized one and garbage, and adds nothing", async () => {
    const { channel, added } = await serve();
    expect(await sendToFilter(channel.path, "")).toBe(false);
    expect(await sendToFilter(channel.path, "x".repeat(5000))).toBe(false);
    const raw = await new Promise<string>(resolve => {
      const socket = connect(channel.path);
      let text = "";
      socket.on("data", chunk => { text += String(chunk); });
      socket.on("close", () => { resolve(text); });
      socket.write("not json\n");
    });
    expect(raw.trim()).toBe("no");
    expect(added).toEqual([]);
  });

  it("holds a bounded number of distinct keys; one it already has is still a yes", async () => {
    const { channel, added } = await serve(2);
    expect(await sendToFilter(channel.path, "alpha-synthetic-one")).toBe(true);
    expect(await sendToFilter(channel.path, "bravo-synthetic-two")).toBe(true);
    expect(await sendToFilter(channel.path, "charlie-synthetic-three")).toBe(false);
    expect(await sendToFilter(channel.path, "alpha-synthetic-one")).toBe(true);
    expect(added).toEqual(["alpha-synthetic-one", "bravo-synthetic-two"]);
  });

  it("says no when nobody listens, and after the run closed it; the directory goes with it", async () => {
    const { channel } = await serve();
    const path = channel.path;
    await channel.close();
    expect(existsSync(dirname(path))).toBe(false);
    expect(await sendToFilter(path, KEY)).toBe(false);
    expect(await sendToFilter("/nonexistent/dir/f.sock", KEY)).toBe(false);
  });

  it("says no when the listener never answers, within the time it was given", async () => {
    const { channel } = await serve();
    const quiet = createServer(socket => { socket.on("data", () => undefined); });
    const path = `${dirname(channel.path)}/quiet.sock`;
    await new Promise<void>(resolve => { quiet.listen(path, resolve); });
    closers.push(() => new Promise<void>(resolve => { quiet.close(() => { resolve(); }); }));
    const started = Date.now();
    expect(await sendToFilter(path, KEY, 150)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
