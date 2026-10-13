// A name the hub accepted has to land on the node. The hub's `pasted-<stamp>-<id>-` prefix is 30 characters, so the
// node is asked for the name the owner gave, and a name over 80 characters is shortened by its stem, extension kept.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { endpointId } from "@morndo/domain";
import { UploadInbox } from "../../node-agent/src/ops/upload-inbox.ts";
import { stagedUploadName, uploadInbox } from "../src/adapters/uploads.ts";

const ctx = { ready: () => null, remainingMs: () => 5_000 };
let hubDir = "";
let nodeDir = "";
afterEach(() => { rmSync(hubDir, { recursive: true, force: true }); rmSync(nodeDir, { recursive: true, force: true }); });

async function through(name: string, bytes: Buffer) {
  rmSync(hubDir, { recursive: true, force: true });
  rmSync(nodeDir, { recursive: true, force: true });
  hubDir = mkdtempSync(join(tmpdir(), "morndo-hub-inbox-"));
  nodeDir = mkdtempSync(join(tmpdir(), "morndo-node-inbox-"));
  const saved = await uploadInbox({ dir: hubDir }).save(bytes, endpointId("ep1"), name);
  if (!saved.ok) throw new Error(saved.error);
  const asked = stagedUploadName(saved.value.path);
  const node = new UploadInbox({ dir: nodeDir });
  const put = await node.put({ upload: "up1", offset: 0, bytes: bytes.toString("base64"), final: true, name: asked }, ctx);
  return { stored: basename(saved.value.path), asked, put };
}

describe("a long name from the hub to the node", () => {
  it("keeps a 51-character and a 90-character markdown name and PDF name", async () => {
    const md51 = `${"n".repeat(48)}.md`;
    const md90 = `${"n".repeat(87)}.md`;
    const pdf51 = `${"p".repeat(47)}.pdf`;
    const pdf90 = `${"p".repeat(86)}.pdf`;
    const md = await through(md51, Buffer.from("# Hi\n"));
    expect(md.stored.length).toBeGreaterThan(80);
    expect(md.asked).toBe(md51);
    expect(md.put.ok && md.put.result.path?.endsWith(md51)).toBe(true);
    const longMd = await through(md90, Buffer.from("# Hi\n"));
    expect(longMd.asked.endsWith(".md") && longMd.asked.length === 80 && longMd.asked !== md90).toBe(true);
    expect(longMd.put.ok && longMd.put.result.path?.endsWith(longMd.asked)).toBe(true);
    const pdf = await through(pdf51, Buffer.from("%PDF-1.7\n"));
    expect(pdf.asked).toBe(pdf51);
    expect(pdf.put.ok && pdf.put.result.path?.endsWith(".pdf")).toBe(true);
    const longPdf = await through(pdf90, Buffer.from("%PDF-1.7\n"));
    expect(longPdf.asked.endsWith(".pdf") && longPdf.asked.length === 80).toBe(true);
    expect(longPdf.put.ok && longPdf.put.result.path?.endsWith(longPdf.asked)).toBe(true);
  });
});
