// End-to-end check that the desktop client follows the Ink colour rules (packages/brand/COLOR.md) on synthetic agents:
// no hue outside the status tokens; a focus ring that stays visible on the dark frame and on the page; the tokens' own
// theme switch (system scheme, data-theme on <html>) reaching the app; and the UI states of rules 8-11 (hover, fill,
// selection with its ink bar, full text on tints, avatars, quiet buttons, recessed areas), including hover states.
// It also checks the build: no brand package sources and no light-dark() in it. Run: npm run build && node e2e/ink.e2e.ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { themes } from "@morndo/brand";
// @ts-expect-error apca-w3 ships no types (packages/brand/test/apca-w3.d.ts declares them for the brand tests only)
import { APCAcontrast, sRGBtoY } from "apca-w3";
import { launch } from "./harness.ts";
import { buildOffice } from "./office.ts";

const ROOT = join(import.meta.dirname, "..");
const OUT = process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), "morndo-ink-out-"));
const HOME = mkdtempSync(join(tmpdir(), "morndo-ink-"));
mkdirSync(OUT, { recursive: true });

const results: { name: string; ok: boolean }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`); }
  catch (e) { results.push({ name, ok: false }); console.log(`FAIL  ${name}\n      ${(e as Error).message.split("\n").join("\n      ")}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const freePort = () => new Promise<number>(r => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

// The only colours Ink allows to carry a hue: the status indicator, text and subtle tokens, in either theme.
const STATUS = Object.values(themes).flatMap(t => [t.success, t.successText, t.successSubtle, t.warning, t.warningText, t.warningSubtle,
  t.danger, t.dangerText, t.dangerSubtle]);
const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
const css = (h: string) => `rgb(${rgb(h).join(", ")})`;                // a token as getComputedStyle reports it
// Translucent tokens (#rrggbbaa, e.g. the hover state layer): compare channels and alpha, and composite onto a base.
const rgbaOf = (v: string) => { const n = v.match(/[\d.]+/g)!.map(Number); return [n[0]!, n[1]!, n[2]!, n[3] ?? 1] as const; };
const tokenRgba = (h: string) => [...rgb(h), h.length > 7 ? parseInt(h.slice(7, 9), 16) / 255 : 1] as const;
const sameColor = (a: readonly number[], b: readonly number[]) =>
  a.slice(0, 3).every((c, i) => Math.abs(c - b[i]!) <= 1) && Math.abs(a[3]! - b[3]!) <= 0.01;
const over = (fg: string, base: string) => { const f = rgbaOf(fg), b = rgbaOf(base);
  return `rgb(${[0, 1, 2].map(i => Math.round(f[i]! * f[3] + b[i]! * (1 - f[3]))).join(", ")})`; };

/** Every coloured CSS value under .desk whose OKLCH chroma is 0.02 or more and that isn't a status token. */
async function hues(page: Page): Promise<string[]> {
  return page.evaluate(({ status }) => {
    const parse = (v: string): [number, number, number, number] | null => {
      const m = v.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
      if (m) return [+m[1]!, +m[2]!, +m[3]!, m[4] === undefined ? 1 : +m[4]];
      const c = v.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/);
      return c ? [+c[1]! * 255, +c[2]! * 255, +c[3]! * 255, c[4] === undefined ? 1 : +c[4]] : null;
    };
    const chroma = ([r, g, b]: number[]) => {                       // sRGB -> OKLab (Ottosson), then the chroma of a and b
      const [R, G, B] = [r!, g!, b!].map(c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      const l = Math.cbrt(0.4122214708 * R! + 0.5363325363 * G! + 0.0514459929 * B!);
      const m = Math.cbrt(0.2119034982 * R! + 0.6806995451 * G! + 0.1073969566 * B!);
      const s = Math.cbrt(0.0883024619 * R! + 0.2817188376 * G! + 0.6299787005 * B!);
      const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
      return Math.hypot(a, bb);
    };
    const isStatus = (c: number[]) => status.some(s => s.every((v, i) => Math.abs(v - c[i]!) <= 2));
    const out = new Set<string>();
    const desk = document.querySelector(".desk")!;
    for (const el of [desk, ...desk.querySelectorAll("*")]) {
      if (el.closest(".xterm, img, video, canvas, .screen")) continue;     // content, not chrome: the terminal's ANSI colours, media
      const st = getComputedStyle(el);
      const values = [st.color, st.backgroundColor];
      for (const side of ["Top", "Right", "Bottom", "Left"] as const)
        if (parseFloat(st[`border${side}Width`]) > 0) values.push(st[`border${side}Color`]);
      if (st.outlineStyle !== "none") values.push(st.outlineColor);
      if (el instanceof SVGElement) values.push(st.fill, st.stroke);
      values.push(...(`${st.boxShadow} ${st.backgroundImage}`.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/g) ?? []));
      for (const v of values) {
        const c = parse(v);
        if (!c || c[3] === 0 || chroma(c) < 0.02 || isStatus(c)) continue;
        out.add(`${el.tagName.toLowerCase()}.${[...el.classList].filter(k => !k.startsWith("svelte-")).join(".")} ${v}`);
      }
    }
    return [...out];
  }, { status: STATUS.map(rgb) });
}

/** WCAG 2 contrast between two computed rgb() colours. */
const contrast = (a: string, b: string) => {
  const L = (v: string) => { const [r, g, bl] = v.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!; };
  const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05);
};
/** Moves keyboard focus onto the target (Shift+Tab then Tab, so :focus-visible applies) and reads its ring. */
async function ring(page: Page, selector: string) {
  await page.locator(selector).first().focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const r = await page.evaluate(sel => {
    const el = document.activeElement as HTMLElement, st = getComputedStyle(el);
    return { matches: el.matches(sel), active: `${el.tagName.toLowerCase()}.${[...el.classList].filter(k => !k.startsWith("svelte-")).join(".")}`,
      visible: el.matches(":focus-visible"), style: st.outlineStyle, width: st.outlineWidth, offset: st.outlineOffset, color: st.outlineColor };
  }, selector);
  assert(r.matches, `Shift+Tab, Tab left focus on ${r.active}, not on ${selector}: its ring isn't the one asked for`);
  return r;
}
const bg = (page: Page, selector: string) => page.locator(selector).first().evaluate(e => getComputedStyle(e).backgroundColor);

// The build ships no source files of the brand package: importing its TS entry from the web (import.meta.url there) made
// Vite bundle the package's README, COLOR.md, package-lock.json and tsconfig as public, precached assets.
await check("the web build ships no brand package sources (no .md or .json among its assets or in the service worker)", async () => {
  const assets = join(ROOT, "apps/web/build/_app/immutable/assets");
  const leaked = readdirSync(assets).filter(f => /\.(md|json)$/.test(f));
  const sw = readFileSync(join(ROOT, "apps/web/build/service-worker.js"), "utf8");
  const precached = [...sw.matchAll(/immutable\/assets\/[^"'`,\s]+\.(?:md|json)\b/g)].map(m => m[0]);
  assert(leaked.length === 0 && precached.length === 0, `leaked into the build: ${[...leaked, ...precached].join(", ")}`);
});

// Raw light-dark() has no fallback: where a browser lacks it (Safari before 17.5) a value built on it becomes transparent,
// e.g. avatar tiles with white initials on white. The build lowers it to lightningcss's --lightningcss-light/-dark
// variables, which work there; this fails if a raw light-dark() ever reaches the output.
await check("the built CSS uses no light-dark()", async () => {
  const dir = join(ROOT, "apps/web/build/_app/immutable/assets");
  const using = readdirSync(dir).filter(f => f.endsWith(".css") && readFileSync(join(dir, f), "utf8").includes("light-dark("));
  assert(using.length === 0, `light-dark() in ${using.join(", ")}`);
});

const port = await freePort();
const office = buildOffice({ home: HOME, socket: `morndo-ink-${process.pid}`, vncPort: await freePort() });
const env = { ...process.env, ...office.env(port) };
const hubMain = join(ROOT, "apps/hub/src/main.ts");
// Started inside the try, so a hub or browser that fails to start still has the office (tmux server, VNC) stopped.
let hub: ChildProcess | null = null;
let browser: Browser | null = null;
const consoleErrors: string[] = [];                                     // console errors and CSP violations, both schemes
try {
  hub = spawn(process.execPath, [hubMain, "serve"], { env, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((res, rej) => { hub?.stdout?.on("data", d => { if (String(d).includes("morndo hub on")) res(); }); hub?.once("exit", c => rej(new Error(`hub exited ${c}`))); });
  browser = await launch();
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 908 }, colorScheme: scheme });
    const page = await context.newPage();
    page.on("console", m => { if (m.type() === "error") consoleErrors.push(`${scheme}: ${m.text()}`); });
    page.on("pageerror", e => consoleErrors.push(`${scheme}: ${e.message}`));
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(execFileSync(process.execPath, [hubMain, "pair"], { env, encoding: "utf8" }).split("\n").find(l => l.includes("/pair#t="))?.trim() ?? "");
    await page.getByRole("button", { name: "Create passkey and pair" }).click();
    await page.locator(".desk").waitFor({ timeout: 10_000 });
    const t = themes[scheme];

    await check(`${scheme}: no hue outside the status tokens (manager chat, decisions panel, an agent with files, the menu)`, async () => {
      await page.getByRole("button", { name: "Manager", exact: true }).first().click();
      await page.getByRole("complementary", { name: "Decisions" }).locator("[data-decision]").first().waitFor();
      const found = await hues(page);
      await page.locator("aside.side").getByRole("button", { name: /builder/ }).click();
      // The builder sends files (e2e/office.ts); each renders as a figure.att (Attachments.svelte). Audit them, not an
      // empty pane: no tile, no pass.
      const tiles = page.locator(".pane .files figure.att");
      await tiles.first().waitFor({ timeout: 10_000 });
      await tiles.locator(".card").first().waitFor();                           // the file cards as well as the images
      found.push(...await hues(page));
      await page.locator("aside.side").getByRole("button", { name: /Manager/ }).first().click({ button: "right" });
      await page.getByRole("menu").waitFor();
      found.push(...await hues(page));
      await page.screenshot({ path: join(OUT, `ink-${scheme}-menu.png`) });
      await page.keyboard.press("Escape");
      assert(found.length === 0, `decorative hues:\n${[...new Set(found)].join("\n")}`);
    });

    await check(`${scheme}: the focus ring is the token's 2px solid ring, at least 3:1 on the dark frame and on the page`, async () => {
      const frame = await bg(page, ".desk");
      const onFrame = await ring(page, ".rail .tab");
      assert(onFrame.visible && onFrame.style === "solid" && onFrame.width === "2px" && onFrame.offset === "2px", `rail ring ${JSON.stringify(onFrame)}`);
      assert(contrast(onFrame.color, frame) >= 3, `rail ring ${onFrame.color} on frame ${frame}: ${contrast(onFrame.color, frame).toFixed(2)}:1`);
      const onPage = await ring(page, "aside.side .row");
      const side = await bg(page, "aside.side");
      assert(onPage.visible && onPage.style === "solid" && onPage.width === "2px", `sidebar ring ${JSON.stringify(onPage)}`);
      assert(contrast(onPage.color, side) >= 3, `sidebar ring ${onPage.color} on ${side}: ${contrast(onPage.color, side).toFixed(2)}:1`);
      await page.screenshot({ path: join(OUT, `ink-${scheme}-focus.png`) });
    });

    await check(`${scheme}: the system scheme reaches the app, and data-theme on <html> overrides it`, async () => {
      const want = (h: string) => `rgb(${rgb(h).join(", ")})`;
      const other = themes[scheme === "light" ? "dark" : "light"];
      const recessed = (th: typeof t) => th.bg;                                   // recessed areas: bg in both themes (COLOR.md 11)
      assert(await bg(page, ".panel") === want(t.surface), `panel ${await bg(page, ".panel")} != surface ${t.surface}`);
      assert(await bg(page, ".bar") === want(recessed(t)), `composer bar ${await bg(page, ".bar")} != ${recessed(t)}`);
      await page.evaluate(s => { document.documentElement.dataset.theme = s; }, scheme === "light" ? "dark" : "light");
      try {
        assert(await bg(page, ".panel") === want(other.surface), `with data-theme, panel ${await bg(page, ".panel")} != ${other.surface}`);
        assert(await bg(page, ".bar") === want(recessed(other)), `with data-theme, composer bar ${await bg(page, ".bar")} != ${recessed(other)}`);
      } finally {
        await page.evaluate(() => { delete document.documentElement.dataset.theme; });   // never leaks into the steps after
      }
    });

    await check(`${scheme}: the status pill on the dark frame takes the dark theme's status text in both themes`, async () => {
      const pill = page.locator(".top .conn.live");                                // data-theme="dark" on a subtree
      await pill.waitFor();
      const color = await pill.evaluate(e => getComputedStyle(e).color);
      const want = `rgb(${rgb(themes.dark.successText).join(", ")})`;
      assert(color === want, `live pill ${color} != dark success text ${want}`);
    });
    // Ink UI states, packages/brand/COLOR.md rules 8-11 (product lane, 2026-10-02).
    await check(`${scheme}: the open conversation is selection with a 3px ink bar, stronger than a hovered row, in full text`, async () => {
      await page.getByRole("button", { name: "Manager", exact: true }).first().click();
      const sel = page.locator("aside.side .row.sel").first();
      await sel.waitFor();
      await page.waitForTimeout(200);                                              // past any background transition
      const s = await sel.evaluate(e => { const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color, shadow: c.boxShadow,
        left: `${c.borderLeftWidth} ${c.borderLeftStyle} ${c.borderLeftColor}` }; });
      assert(s.bg === css(t.selection), `open conversation ${s.bg} != selection ${t.selection}`);
      assert(s.color === css(t.text), `open conversation text ${s.color} != text ${t.text}`);
      const bar = (s.shadow.includes(css(t.ink)) && /\b3px\b/.test(s.shadow)) || s.left === `3px solid ${css(t.ink)}`;
      assert(bar, `no 3px ink bar on the open conversation: box-shadow ${s.shadow}; border-left ${s.left}`);
      const other = page.locator("aside.side .row:not(.sel):not(.static)").first();
      await other.hover();
      await page.waitForTimeout(250);
      const h = await other.evaluate(e => { const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color }; });
      const side = await bg(page, "aside.side");
      await page.mouse.move(5, 5);
      assert(sameColor(rgbaOf(h.bg), tokenRgba(t.hover)), `hovered row ${h.bg} != hover ${t.hover}`);
      assert(h.color === css(t.text), `hovered row text ${h.color} != text ${t.text}`);
      const shown = over(h.bg, side);                                              // the hover layer as it shows on the sidebar
      assert(contrast(s.bg, side) > contrast(shown, side),
        `selection ${contrast(s.bg, side).toFixed(2)}:1 is not stronger than hover ${contrast(shown, side).toFixed(2)}:1 on the sidebar`);
    });

    await check(`${scheme}: neutral chips are fill in full text, and every avatar's initials are at least 4.5:1`, async () => {
      const app = await page.locator(".pane .app").first().evaluate(e => ({ bg: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color }));
      assert(app.bg === css(t.fill), `the AGENT tag ${app.bg} != fill ${t.fill}`);
      assert(app.color === css(t.text), `the AGENT tag text ${app.color} != text ${t.text}`);
      const avs = await page.locator(".av").evaluateAll(els => els.filter(e => (e as HTMLElement).offsetParent).map(e => {
        const c = getComputedStyle(e); return { cls: e.className.replace(/svelte-\S+/g, "").trim(), bg: c.backgroundColor, color: c.color }; }));
      assert(avs.length > 0, "no avatar on screen");
      const weak = avs.filter(a => contrast(a.color, a.bg) < 4.5).map(a => `${a.cls}: ${a.color} on ${a.bg} ${contrast(a.color, a.bg).toFixed(2)}:1`);
      assert(weak.length === 0, `avatar initials under 4.5:1:\n${[...new Set(weak)].join("\n")}`);
      const own = avs.find(a => /\bprincipal\b/.test(a.cls));
      if (own) assert(own.bg === css(t.ink) && own.color === css(t.inkFg), `the principal's avatar ${own.color} on ${own.bg}, want ink-fg on ink`);
    });

    await check(`${scheme}: a decision's primary button is ink and turns ink-hover under the pointer`, async () => {
      const btn = page.getByRole("complementary", { name: "Decisions" }).locator(".btn.primary").first();
      await btn.waitFor();
      const rest = await btn.evaluate(e => getComputedStyle(e).backgroundColor);
      await btn.hover();
      await page.waitForTimeout(250);
      const over = await btn.evaluate(e => getComputedStyle(e).backgroundColor);
      await page.mouse.move(5, 5);
      assert(rest === css(t.ink), `primary button ${rest} != ink ${t.ink}`);
      assert(over === css(t.inkHover), `primary button on hover ${over} != ink-hover ${t.inkHover}`);
    });

    await check(`${scheme}: the Ctrl+K highlighted result is the selection tint in full text`, async () => {
      await page.locator("#top-search").fill("worker");
      const hit = page.locator(".hits button.active").first();
      await hit.waitFor();
      const h = await hit.evaluate(e => ({ bg: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color }));
      await page.locator("#top-search").fill("");
      await page.keyboard.press("Escape");
      assert(h.bg === css(t.selection), `highlighted result ${h.bg} != selection ${t.selection}`);
      assert(h.color === css(t.text), `highlighted result text ${h.color} != text ${t.text}`);
    });

    await check(`${scheme}: the details modal's body is the page background under surface cards`, async () => {
      await page.locator("aside.side").getByRole("button", { name: /builder/ }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Conversation details" }).click();
      await page.locator(".modal .card").first().waitFor();
      const body = await bg(page, ".modal .body"), card = await bg(page, ".modal .card");
      await page.keyboard.press("Escape");
      assert(body === css(t.bg), `modal body ${body} != bg ${t.bg}`);
      assert(card === css(t.surface), `modal card ${card} != surface ${t.surface}`);
    });

    // Round 2 of the Ink review (2026-10-02): state colours on tints, and the open Decisions row.
    await check(`${scheme}: an urgent activity item keeps its danger line under the pointer; its other lines are full text`, async () => {
      await page.locator(".rail").getByRole("button", { name: /Activity/ }).click();
      const item = page.locator(".item.urgent").first();
      await item.waitFor();
      await item.hover();
      await page.waitForTimeout(250);
      const r = await item.evaluate(e => ({ why: getComputedStyle(e.querySelector(".why")!).color,
        others: [...e.querySelectorAll("p:not(.why), strong")].map(k => getComputedStyle(k).color) }));
      await page.mouse.move(5, 5);
      await page.locator(".rail").getByRole("button", { name: /Chats/ }).click();
      assert(r.why === css(t.dangerText), `urgent line on hover ${r.why} != danger text ${t.dangerText}`);
      assert(r.others.every(c => c === css(t.text)), `other lines on hover ${r.others.join(", ")} != text ${t.text}`);
    });

    await check(`${scheme}: everything in the highlighted Ctrl+K result is full text at full opacity`, async () => {
      await page.locator("#top-search").fill("worker");
      const hit = page.locator(".hits button.active").first();
      await hit.waitFor();
      const kids = await hit.evaluate(e => [...e.querySelectorAll("*")].filter(k => k.children.length === 0 && k.textContent?.trim())
        .map(k => { let o = 1; for (let n: Element | null = k; n && n !== e.parentElement; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
          return { text: k.textContent!.trim().slice(0, 20), color: getComputedStyle(k).color, opacity: o }; }));
      await page.locator("#top-search").fill("");
      await page.keyboard.press("Escape");
      const off = kids.filter(k => k.color !== css(t.text) || k.opacity < 1).map(k => `${k.text}: ${k.color} at ${k.opacity}`);
      assert(kids.length > 0 && off.length === 0, `muted or dimmed text on the selection tint: ${off.join("; ")}`);
    });

    await check(`${scheme}: the open Decisions row is selection with the ink bar`, async () => {
      const row = page.locator("aside.side .row.static.on").first();               // the panel is open by default
      await row.waitFor();
      const s = await row.evaluate(e => { const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color, shadow: c.boxShadow,
        left: `${c.borderLeftWidth} ${c.borderLeftStyle} ${c.borderLeftColor}` }; });
      assert(s.bg === css(t.selection), `open Decisions row ${s.bg} != selection ${t.selection}`);
      assert(s.color === css(t.text), `open Decisions row text ${s.color} != text`);
      assert((s.shadow.includes(css(t.ink)) && /\b3px\b/.test(s.shadow)) || s.left === `3px solid ${css(t.ink)}`, `no ink bar: ${s.shadow}; ${s.left}`);
    });

    await check(`${scheme}: the composer's "verified" status keeps APCA Lc 75 under the pointer`, async () => {
      const v = page.locator(".verify.fresh").first();
      await v.waitFor();
      await v.hover();
      await page.waitForTimeout(250);
      const r = await v.evaluate(e => ({ color: getComputedStyle(e).color, bg: getComputedStyle(e).backgroundColor }));
      await page.mouse.move(5, 5);
      const toHex = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number) as [number, number, number];
      const surface = css(t.surface);
      const under = /^rgba\(.*,\s*0\)$/.test(r.bg) || r.bg === "transparent" ? surface : r.bg;
      const lc = Math.abs(Number(APCAcontrast(sRGBtoY(toHex(r.color)), sRGBtoY(toHex(under)))));
      assert(lc >= 75, `"verified" on hover: ${r.color} on ${under} is Lc ${lc.toFixed(1)}, under 75`);
    });

    await check(`${scheme}: quiet buttons on the devices page are transparent with a 3:1 edge`, async () => {
      await page.goto(`${new URL(page.url()).origin}/devices`);
      const q = page.locator(".btn.quiet").first();
      await q.waitFor();
      const s = await q.evaluate(e => {
        const c = getComputedStyle(e);
        let behind = "rgb(255, 255, 255)";
        for (let p = e.parentElement; p; p = p.parentElement) {
          const b = getComputedStyle(p).backgroundColor;
          if (b !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(b)) { behind = b; break; }
        }
        return { bg: c.backgroundColor, width: c.borderTopWidth, edge: c.borderTopColor, behind };
      });
      assert(s.bg === "transparent" || /^rgba\(.*,\s*0\)$/.test(s.bg), `quiet button fill ${s.bg}, want transparent`);
      assert(parseFloat(s.width) >= 1, `quiet button edge width ${s.width}`);
      assert(contrast(s.edge, s.behind) >= 3, `quiet button edge ${s.edge} on ${s.behind}: ${contrast(s.edge, s.behind).toFixed(2)}:1`);
      await page.screenshot({ path: join(OUT, `ink-${scheme}-devices.png`) });
    });
    await context.close();
  }

  await check("no console errors or CSP violations in either scheme", async () => {
    assert(consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
  });
} finally {
  await browser?.close();
  await new Promise<void>(r => {
    if (!hub || hub.exitCode !== null || hub.signalCode !== null) return r();   // never started, or already gone
    hub.once("exit", () => r()); hub.kill("SIGTERM");
  });
  office.stop();
  rmSync(HOME, { recursive: true, force: true });
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
