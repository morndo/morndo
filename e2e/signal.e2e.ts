// End-to-end checks for the patterns borrowed from Signal (ADR-0008), on a synthetic office with its own hub: the real
// hub and built app in headless Chromium. Run: npm run build && node e2e/signal.e2e.ts
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { assert, checks, launch, newDevice, outDir, pairedPage, startOffice } from "./harness.ts";

const OUT = outDir("signal");
const office = await startOffice("signal");
const { check, watch, finish } = checks(OUT);
const browser = await launch();
let code = 1;
try {
  // Service workers blocked: the reload check holds a POST with page.route, which can't see requests made under the
  // app's service worker once it controls the page. The push checks open their own context with it.
  const { context, page, errors } = await pairedPage(browser, office, { serviceWorkers: "block" });
  watch(page);
  const status = page.locator("header .conn, .conn").first();
  await page.locator("aside.side").getByText("builder", { exact: true }).waitFor({ timeout: 10_000 });

  // ---- phase B: connection liveness
  await check("offline shows Offline; online shows Live again, and what happened meanwhile arrives", async () => {
    await status.filter({ hasText: "Live" }).waitFor({ timeout: 10_000 });
    await context.setOffline(true);
    await status.filter({ hasText: "Offline" }).waitFor({ timeout: 5000 });
    await page.screenshot({ path: join(OUT, "b-offline.png") });
    office.tmux("rename-window", "-t", "qa:reviewer", "reviewer-two");     // an event while the app can't hear it
    await page.waitForTimeout(1500);
    assert(await page.locator("aside.side").getByText("reviewer-two", { exact: true }).count() === 0, "an event arrived while offline");
    await context.setOffline(false);
    await status.filter({ hasText: "Live" }).waitFor({ timeout: 10_000 });
    await page.locator("aside.side").getByText("reviewer-two", { exact: true }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(OUT, "b-back-online.png") });
  });

  // ---- phase C: the durable outbox. The office's agents are bash under a drawn input box, so a typed `: token` lands
  // in the pane once per typing and prints nothing.
  const pane = (name: string) => office.tmux("capture-pane", "-p", "-J", "-t", `qa:${name}`, "-S", "-200");
  const typedTimes = (name: string, token: string) => pane(name).split(token).length - 1;
  const openChat = async (name: RegExp) => {
    await page.locator("aside.side").getByRole("button", { name }).first().click();
    await page.getByRole("textbox", { name: /^Message / }).waitFor();
  };
  const composer = () => page.getByRole("textbox", { name: /^Message / });

  await check("a reload in the middle of a send resumes it, and the agent gets it exactly once", async () => {
    await openChat(/builder/);
    let held = true;
    await page.route("**/api/workers/*/send", route => { if (held) { held = false; return; } void route.continue(); });   // the first POST never answers
    await composer().fill(": reload-token-1");
    await composer().press("Enter");
    await page.waitForTimeout(800);
    assert(typedTimes("builder", "reload-token-1") === 0, "typed before the reload");
    await page.reload();
    await page.locator(".desk").waitFor();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && typedTimes("builder", "reload-token-1") === 0) await page.waitForTimeout(300);
    await page.waitForTimeout(1500);                                       // time for a second, wrong typing to show
    assert(typedTimes("builder", "reload-token-1") === 1, `typed ${typedTimes("builder", "reload-token-1")} times`);
    await page.unroute("**/api/workers/*/send");
  });

  await check("written offline, it waits as Queued and the agent gets it once the network is back", async () => {
    await openChat(/builder/);
    await context.setOffline(true);
    await status.filter({ hasText: "Offline" }).waitFor({ timeout: 5000 });
    await composer().fill(": offline-token-2");
    await composer().press("Enter");
    await page.locator("article.pending", { hasText: "offline-token-2" }).locator("time", { hasText: "Queued" }).waitFor();
    await page.screenshot({ path: join(OUT, "c-queued-offline.png") });
    await page.waitForTimeout(1500);
    assert(typedTimes("builder", "offline-token-2") === 0, "typed while offline");
    await context.setOffline(false);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && typedTimes("builder", "offline-token-2") === 0) await page.waitForTimeout(300);
    await page.waitForTimeout(1500);
    assert(typedTimes("builder", "offline-token-2") === 1, `typed ${typedTimes("builder", "offline-token-2")} times`);
  });

  // ---- phase D: reading comfort. Agents' transcripts get synthetic lines appended, as a working agent's would.
  const transcriptOf = (name: string) => join(office.office.claudeDir, "projects", "-qa", `s-${name}.jsonl`);
  let line = 0;
  const say = (name: string, text: string, at = Date.now()) => appendFileSync(transcriptOf(name), JSON.stringify({
    type: "assistant", uuid: `e2e-${name}-${++line}`, timestamp: new Date(at).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) + "\n");
  const side = (p: typeof page) => p.locator("aside.side");

  // Sent while the agent works: Claude Code takes the prompt into the running turn and writes a queued_command
  // attachment with queue-operation records, never a user line (shapes as 2.1.288 wrote them on 2026-10-03).
  await check("a message the agent absorbed in the middle of a turn ends its Sent entry and shows in the conversation", async () => {
    await openChat(/builder/);
    const text = ": absorbed-token-3";
    await composer().fill(text);
    await composer().press("Enter");
    const pending = page.locator("article.pending", { hasText: "absorbed-token-3" });
    await pending.locator("time", { hasText: "Sent" }).waitFor({ timeout: 20_000 });
    const at = new Date().toISOString();
    const put = (o: Record<string, unknown>) => appendFileSync(transcriptOf("builder"), JSON.stringify(o) + "\n");
    put({ type: "queue-operation", operation: "enqueue", timestamp: at, sessionId: "s-builder", content: text });
    put({ type: "queue-operation", operation: "remove", reason: "absorbed_mid_turn", timestamp: at, sessionId: "s-builder", content: text, commandUuid: "cmd-3", deliveryId: "del-3" });
    put({ type: "attachment", uuid: "e2e-absorbed-3", isSidechain: false, timestamp: at,
      attachment: { type: "queued_command", prompt: text, source_uuid: "cmd-3", delivery_id: "del-3", commandMode: "prompt", origin: { kind: "human" }, timestamp: at, humanTurn: true } });
    await page.locator("article:not(.pending)", { hasText: "absorbed-token-3" }).waitFor({ timeout: 15_000 });
    await pending.waitFor({ state: "detached", timeout: 15_000 });
    assert(typedTimes("builder", "absorbed-token-3") === 1, `typed ${typedTimes("builder", "absorbed-token-3")} times`);
    // A long message is a long paste to the agent, which wraps it in <pasted_content …> tags: it ends its entry too.
    const long = `: absorbed-long-token-4 ${"and one more sentence about the login page. ".repeat(6).trim()}`;
    await composer().fill(long);
    await composer().press("Enter");
    const longPending = page.locator("article.pending", { hasText: "absorbed-long-token-4" });
    await longPending.locator("time", { hasText: "Sent" }).waitFor({ timeout: 20_000 });
    const at2 = new Date().toISOString();
    put({ type: "attachment", uuid: "e2e-absorbed-4", isSidechain: false, timestamp: at2,
      attachment: { type: "queued_command", prompt: `<pasted_content id="e2e4">\n${long}\n</pasted_content id="e2e4">`, source_uuid: "cmd-4", delivery_id: "del-4", commandMode: "prompt", origin: { kind: "human" }, timestamp: at2, humanTurn: true } });
    const shown = page.locator("article:not(.pending)", { hasText: "absorbed-long-token-4" });
    await shown.waitFor({ timeout: 15_000 });
    await longPending.waitFor({ state: "detached", timeout: 15_000 });
    assert(!(await shown.innerText()).includes("pasted_content"), "the paste wrapper shows in the message");
    await page.screenshot({ path: join(OUT, "c-absorbed-mid-turn.png") });
  });

  await check("the divider sits before what arrived while away, and the jump button counts what arrives below", async () => {
    await openChat(/reviewer/);
    await page.waitForTimeout(1500);                                         // read to the bottom: the mark moves
    await openChat(/Manager/);
    for (let i = 1; i <= 40; i++) say("reviewer", `review note ${i} of 40`);
    await side(page).locator("button.row.unread", { hasText: "reviewer" }).first().waitFor({ timeout: 10_000 });
    await openChat(/reviewer/);
    await page.locator(".newdiv").waitFor({ timeout: 10_000 });
    const first = await page.locator(".newdiv + article, .newdiv + div").first().innerText();
    assert(first.includes("review note 1 of 40"), `the divider is before: ${first.slice(0, 80)}`);
    await page.screenshot({ path: join(OUT, "d-divider.png") });
    await page.locator(".pane").first().evaluate(el => { el.scrollTop = 0; });
    say("reviewer", "a late note");
    say("reviewer", "another late note");
    await page.locator(".jump", { hasText: /2 new/ }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(OUT, "d-jump.png") });
    await page.locator(".jump").click();
    await page.getByText("another late note").waitFor();
  });

  await check("a draft survives a switch to another conversation and a reload", async () => {
    await openChat(/builder/);
    await composer().fill("a half-written thought for builder");
    await page.waitForTimeout(500);
    await openChat(/Manager/);
    assert(await composer().inputValue() === "", "the draft leaked into another conversation");
    await openChat(/builder/);
    assert(await composer().inputValue() === "a half-written thought for builder", "the draft didn't come back after a switch");
    await page.reload();
    await page.locator(".desk").waitFor();
    await openChat(/builder/);
    assert(await composer().inputValue() === "a half-written thought for builder", "the draft didn't survive the reload");
    await composer().fill("");
  });

  const second = await pairedPage(browser, office, { serviceWorkers: "block" });   // another device of the principal
  await check("two devices: reading on one clears unread on the other, and mute syncs", async () => {
    await openChat(/Manager/);
    say("builder", "builder finished a step");
    await side(second.page).locator("button.row.unread", { hasText: "builder" }).first().waitFor({ timeout: 10_000 });
    await openChat(/builder/);                                                // read here, at the bottom
    await side(second.page).locator("button.row.unread", { hasText: "builder" }).first().waitFor({ state: "detached", timeout: 10_000 });
    await second.page.locator("aside.side").getByRole("button", { name: /reviewer/ }).first().click({ button: "right" });
    await second.page.getByRole("menuitem", { name: "Mute conversation" }).click();
    await side(page).locator("button.row.muted", { hasText: "reviewer" }).first().waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(OUT, "d-muted-synced.png") });
  });
  await second.context.close();

  await check("scrolling up loads older messages without moving what is on screen", async () => {
    // A followed agent's transcript grows by 300 lines, in time order as a real one does; the hub sends the latest 150.
    const start = Date.now();
    for (let i = 0; i < 300; i++) say("builder", `old line ${i}`, start + i);
    await openChat(/builder/);
    await page.getByText("old line 299", { exact: true }).waitFor({ timeout: 15_000 });   // the hub has read them all
    await openChat(/Manager/);
    await openChat(/builder/);                                                     // a fresh history: the latest 150
    await page.getByText("old line 299", { exact: true }).waitFor({ timeout: 15_000 });
    const oldest = await page.locator("article.msg").first().innerText();
    const n = Number(/old line (\d+)/.exec(oldest)?.[1] ?? "-1");
    assert(n > 0, `the history starts at ${oldest.slice(0, 60)}`);
    const anchor = page.getByText(`old line ${n}`, { exact: true });
    // Where the top message sits in the pane: measured in the same task as the scroll, before the older page can arrive.
    const before = await anchor.evaluate(el => {
      const p = el.closest(".pane");
      if (p) p.scrollTop = 0;
      return el.getBoundingClientRect().top - (p?.getBoundingClientRect().top ?? 0);
    });
    await page.getByText(`old line ${Math.max(0, n - 50)}`, { exact: true }).waitFor({ timeout: 10_000 });
    const after = await anchor.evaluate(el => el.getBoundingClientRect().top - (el.closest(".pane")?.getBoundingClientRect().top ?? 0));
    assert(Math.abs(after - before) <= 2, `the message on top moved ${Math.round(after - before)} px: the list jumped (review L8)`);
    await page.screenshot({ path: join(OUT, "d-older.png") });
  });

  // ---- phase E: adding a device from a signed-in one, both ways. Each new device has its own context and its own
  // virtual authenticator; the signed-in one is this page, whose authenticator answers its passkey checks.
  const devicesNow = () => page.evaluate(() => fetch("/api/devices").then(r => r.json()).then((l: { revokedAt: number | null }[]) => l.filter(d => !d.revokedAt).length));
  const verifiedAtOf = (p: typeof page) => p.evaluate(() => fetch("/api/me").then(r => r.json()).then((m: { session: { verifiedAt: number } }) => m.session.verifiedAt));
  const backHome = async () => { await page.goto(office.base); await page.locator(".desk").waitFor({ timeout: 15_000 }); };
  const errorsBeforeLinking = errors.length;

  // Amendment 11: the code is typed, not compared. The new device types the issuing device's code; the approving
  // device types the new device's code; a wrong one ends that token or request at once.
  const digits = (shown: string) => shown.replace(/\D/g, "");
  const wrongOf = (code: string) => (code === "000000" ? "000001" : "000000");
  const shown = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;      // as a screen would show it
  // The warning a code box is described by, as a screen reader reads it with the box (amendment 11; review L8).
  const warningOf = (box: import("playwright").Locator) => box.evaluate(el => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? "");
  const addADevice = async () => {
    await page.getByRole("button", { name: "Add a device" }).click();            // a passkey check first, if due
    const linkBox = page.getByRole("textbox", { name: "Pairing link" });
    await linkBox.waitFor({ timeout: 15_000 });
    const code = await page.locator(".add .code strong").innerText();
    assert(/^\d{3} \d{3}$/.test(code), `the code is ${code}`);
    return { link: await linkBox.inputValue(), code: digits(code) };
  };

  await check("Add a device: a wrong code on the new device ends that link; a new one with the right code pairs, and can't send before its own passkey check", async () => {
    await page.locator(".rail").getByRole("button", { name: "Devices" }).click();
    const first = await addADevice();
    await page.screenshot({ path: join(OUT, "e-add-device.png") });
    const before = await devicesNow();
    const d = await newDevice(browser);
    try {
      await d.page.goto(first.link);
      const codeBox = d.page.getByLabel("Code shown on your signed-in device");
      await codeBox.waitFor({ timeout: 15_000 });
      const pairButton = d.page.getByRole("button", { name: "Create passkey and pair" });
      assert(await pairButton.isDisabled(), "pairing is offered before the code is typed");
      const pairWarning = await warningOf(codeBox);
      assert(pairWarning === "Type the code from the signed-in device you're holding. If someone sent you a code or a QR, stop.", `the warning: ${pairWarning}`);
      assert(!(await d.page.content()).includes(shown(first.code)), "the new device shows the code it should type");
      await codeBox.fill(wrongOf(first.code));
      await pairButton.click();
      await d.page.getByText("That code didn't match, so this has ended.").waitFor({ timeout: 10_000 });
      assert(await pairButton.count() === 0, "a wrong code still offers pairing");
      await d.page.screenshot({ path: join(OUT, "e-pair-wrong-code.png") });
      const again = await d.page.evaluate(([t, c]) => fetch("/api/pair/options", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: t, name: "x", code: c }) }).then(r => r.json()), [new URLSearchParams(new URL(first.link).hash.slice(1)).get("t") ?? "", first.code] as const);
      assert(JSON.stringify(again) === JSON.stringify({ error: "expired" }), `the right code after a wrong one got ${JSON.stringify(again)}`);
      await page.getByRole("button", { name: "Cancel" }).click();
      const second = await addADevice();
      await d.page.goto(second.link);
      await codeBox.waitFor({ timeout: 15_000 });
      await codeBox.fill(second.code);
      await d.page.screenshot({ path: join(OUT, "e-pair-with-code.png") });
      await pairButton.click();
      await d.page.locator(".desk").waitFor({ timeout: 15_000 });
      assert(await verifiedAtOf(d.page) === 0, "the new device has step-up credit (AC12)");
      await page.locator(".add .ok", { hasText: "was added" }).waitFor({ timeout: 10_000 });   // "Add a device" sees it
      await page.getByRole("status").filter({ hasText: "A device was added" }).waitFor({ timeout: 10_000 });   // AC13
      assert(await devicesNow() === before + 1, "not exactly one device more");
      await page.screenshot({ path: join(OUT, "e-device-added.png") });
    } finally { await d.context.close(); }
    await page.keyboard.press("Escape");
  });

  const askToLink = async (d: Awaited<ReturnType<typeof newDevice>>) => {
    await d.page.goto(office.base);
    await d.page.getByRole("button", { name: "Link with a signed-in device" }).click();
    const addressBox = d.page.getByRole("textbox", { name: "Address to approve this device" });
    await addressBox.waitFor({ timeout: 10_000 });
    return { address: await addressBox.inputValue(), code: digits(await d.page.locator(".link-req .code strong").innerText()) };
  };

  await check("Link with a signed-in device: the new device shows a code, this one types it and approves, the new one pairs", async () => {
    const d = await newDevice(browser, { width: 420, height: 900 });
    try {
      const { address, code } = await askToLink(d);
      await d.page.screenshot({ path: join(OUT, "e-link-request.png") });
      await page.goto(address);                                                  // as scanning the code opens it
      await page.getByRole("heading", { name: "Link a new device?" }).waitFor({ timeout: 10_000 });
      assert(!(await page.content()).includes(shown(code)), "the approving device shows the code it should type");
      const linkIt = page.getByRole("button", { name: "Link it" });
      assert(await linkIt.isDisabled(), "Link it is offered before the code is typed");
      const linkWarning = await warningOf(page.getByLabel("The code the new device shows"));
      assert(linkWarning === "Type the code from the device you're holding. If someone sent you a code or a QR, stop.", `the warning: ${linkWarning}`);
      await page.getByLabel("The code the new device shows").fill(code);
      await page.screenshot({ path: join(OUT, "e-link-approve.png") });
      await linkIt.click();
      await page.getByRole("heading", { name: "Linked" }).waitFor({ timeout: 15_000 });
      await d.page.waitForURL(/\/pair/, { timeout: 10_000 });                   // the new device goes on by itself
      const pairButton = d.page.getByRole("button", { name: "Create passkey and pair" });
      await pairButton.waitFor({ timeout: 15_000 });
      assert(await d.page.getByLabel("Code shown on your signed-in device").count() === 0, "a linked device is asked for a code again");
      await pairButton.click();
      await d.page.locator(".phone, .shell, .desk").first().waitFor({ timeout: 15_000 });
      assert(await verifiedAtOf(d.page) === 0, "the linked device has step-up credit (AC12)");
      await d.page.screenshot({ path: join(OUT, "e-linked-phone.png") });
    } finally { await d.context.close(); await backHome(); }
  });

  await check("Link with a signed-in device: a wrong code typed here ends the request on both screens, and nothing is added", async () => {
    const before = await devicesNow();
    const d = await newDevice(browser, { width: 420, height: 900 });
    try {
      const { address, code } = await askToLink(d);
      await page.goto(address);
      await page.getByLabel("The code the new device shows").fill(wrongOf(code));
      await page.getByRole("button", { name: "Link it" }).click();
      await page.getByRole("heading", { name: "The code didn't match" }).waitFor({ timeout: 15_000 });
      await page.screenshot({ path: join(OUT, "e-link-wrong-code.png") });
      await d.page.getByText("The code typed on the other device didn't match, so this request ended. Ask again.").waitFor({ timeout: 10_000 });
      await d.page.screenshot({ path: join(OUT, "e-link-mistyped-phone.png") });
    } finally { await d.context.close(); await backHome(); }
    assert(await devicesNow() === before, "a wrong code added a device");
  });

  await check("deny: the new device hears no, and nothing is added", async () => {
    const before = await devicesNow();
    const d = await newDevice(browser, { width: 420, height: 900 });
    try {
      await d.page.goto(office.base);
      await d.page.getByRole("button", { name: "Link with a signed-in device" }).click();
      const addressBox = d.page.getByRole("textbox", { name: "Address to approve this device" });
      await addressBox.waitFor({ timeout: 10_000 });
      await page.goto(await addressBox.inputValue());
      await page.getByRole("button", { name: "Deny" }).click();
      await page.getByRole("heading", { name: "Denied" }).waitFor({ timeout: 10_000 });
      await d.page.getByText("The other device said no. Nothing was added.").waitFor({ timeout: 10_000 });
      await d.page.screenshot({ path: join(OUT, "e-link-denied.png") });
    } finally { await d.context.close(); await backHome(); }
    assert(await devicesNow() === before, "a denied request added a device");
  });

  await check("expiry: a request past its 10 minutes ends on both screens, and can't be approved", async () => {
    const d = await newDevice(browser, { width: 420, height: 900 });
    try {
      await d.page.goto(office.base);
      await d.page.getByRole("button", { name: "Link with a signed-in device" }).click();
      const addressBox = d.page.getByRole("textbox", { name: "Address to approve this device" });
      await addressBox.waitFor({ timeout: 10_000 });
      const address = await addressBox.inputValue();
      const id = /#r=([0-9a-f-]{36})/.exec(address)?.[1] ?? "";
      // Ten minutes later, without waiting them: the office's own database says the request ended a minute ago.
      const db = new Database(join(office.home, "morndo.db"));
      try { db.prepare("UPDATE link_requests SET expires_at = ? WHERE id = ?").run(Date.now() - 60_000, id); } finally { db.close(); }
      await d.page.getByText("That request expired; they last 10 minutes.").waitFor({ timeout: 10_000 });
      await d.page.getByRole("button", { name: "Ask again" }).waitFor();
      await d.page.screenshot({ path: join(OUT, "e-link-expired.png") });
      await page.goto(address);
      await page.getByRole("heading", { name: "This request is over" }).waitFor({ timeout: 10_000 });
    } finally { await d.context.close(); await backHome(); }
  });

  await check("only the requester's own secret collects: a wrong one gets the same 404 as an unknown request", async () => {
    const asked = await fetch(`${office.base}/api/link`, { method: "POST", headers: { origin: office.base, "content-type": "application/json" }, body: "{}" });
    const r = await asked.json() as { requestId: string; secret: string };
    const poll = (id: string, secret: string) => fetch(`${office.base}/api/link/${id}`, { headers: { "x-morndo-link-secret": secret } });
    const wrong = await poll(r.requestId, "not-the-secret");
    assert(wrong.status === 404, `a wrong secret got ${wrong.status}`);
    const unknown = await poll(crypto.randomUUID(), r.secret);
    assert(unknown.status === 404 && JSON.stringify(await wrong.json()) === JSON.stringify(await unknown.json()), "a wrong secret and an unknown request differ");
    const right = await poll(r.requestId, r.secret);
    assert(right.status === 200 && (await right.json() as { state: string }).state === "waiting", "the right secret isn't answered");
  });

  const errorsBeforeRestart = errors.length;
  await check("the hub dies while typing: after its restart the send is 'May have been sent', never typed again", async () => {
    // Hold the manager pane's lock (as the box's other typists do), so the hub's typing waits inside it: the send is
    // recorded "started" and not yet typed when the hub is killed. -o: flock alone holds it, not its sleep, so killing
    // flock really frees the pane, and a retype after the restart would show (whole-branch review L1).
    const lock = spawn("flock", ["-o", "-x", join(office.home, "pane.lock"), "-c", "sleep 60"], { stdio: "ignore" });
    // The hub's own record of sends: the one this check sends is "started" once the hub has taken it (and waits for the
    // lock). Killed before that, there is nothing to be in doubt about, and the check would test nothing: a fixed 1.5 s
    // wait missed it on a slow CI runner (PR #17, run 37783175499), so it waits for the row itself.
    const started = () => {
      const db = new Database(join(office.home, "morndo.db"), { readonly: true });
      try { return (db.prepare("SELECT COUNT(*) AS n FROM sends WHERE state = 'started'").get() as { n: number }).n; } finally { db.close(); }
    };
    try {
      await page.waitForTimeout(300);
      await openChat(/Manager/);
      const before = started();
      await composer().fill(": restart-token-3");
      await composer().press("Enter");
      const deadline = Date.now() + 15_000;
      while (started() === before) {                                       // the POST is in, recorded, waiting for the lock
        assert(Date.now() < deadline, "the hub never recorded the send as started");
        await page.waitForTimeout(100);
      }
      await office.restartHub("SIGKILL");
      lock.kill();
      const entry = page.locator("article.pending", { hasText: "restart-token-3" });
      await entry.getByText(/May have been sent/).first().waitFor({ timeout: 30_000 });
      await page.screenshot({ path: join(OUT, "c-uncertain.png") });
      await page.waitForTimeout(2000);
      assert(typedTimes("manager", "restart-token-3") === 0, "typed after the restart");
      assert(await entry.getByRole("button", { name: "Retry" }).count() === 0, "an uncertain send offers Retry");
    } finally { lock.kill(); }
  });

  await check("no console errors or uncaught exceptions so far", async () => {
    // On purpose: the offline checks' own disconnection, and, during the hub's restart only, its dropped connections
    // (a SIGKILL resets what was in flight; seen once under load) and the 409 it answers. Anything else, before or
    // after, counts.
    const offline = /net::ERR_INTERNET_DISCONNECTED/;
    const restart = /net::ERR_INTERNET_DISCONNECTED|net::ERR_CONNECTION_REFUSED|net::ERR_CONNECTION_RESET|net::ERR_EMPTY_RESPONSE|status of 409|WebSocket connection to .* failed/;
    // Also on purpose: the page leaving the app for the approval page and back (phase E) drops its sockets.
    // And the hub refusing a wrong code with 409 (amendment 11), which the page shows as such.
    const leaving = /WebSocket connection to .* failed|net::ERR_ABORTED|status of 409/;
    const real = errors.filter((e, i) => !(i < errorsBeforeLinking ? offline : i < errorsBeforeRestart ? leaving : restart).test(e));
    assert(real.length === 0, real.join(" | "));
  });
  await context.close();
  code = finish();
} finally {
  await browser.close();
  office.stop();
}
process.exit(code);
