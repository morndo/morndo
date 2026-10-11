import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchModelIds, modelMissing, sameModel } from "../src/adapters/models.ts";

const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");

describe("model lists", () => {
  it("reads an endpoint list and notices a missing default", async () => {
    const seen: { apiKey?: string | undefined; authorization?: string | undefined }[] = [];
    const server = createServer((req, res) => {
      seen.push({
        apiKey: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
        authorization: req.headers.authorization,
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "other-model" }] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("port");
    const body = JSON.parse(readFileSync(catalog, "utf8")) as { id: string; models: { url?: string } }[];
    const preset = body.find(row => row.id === "anthropic");
    if (!preset) throw new Error("preset");
    preset.models.url = `http://127.0.0.1:${address.port}/models`;
    const ids = await fetchModelIds(preset as never, "sk-ant-synthetic");
    server.close();
    expect(seen[0]?.apiKey).toBe("sk-ant-synthetic");
    expect(seen[0]?.authorization).toBeUndefined();
    const openai = { ...preset, models: { ...preset.models, shape: "openai-list" } };
    const again = createServer((req, res) => {
      seen.push({ authorization: req.headers.authorization, apiKey: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined });
      res.end(JSON.stringify({ data: [{ id: "gpt" }] }));
    });
    await new Promise<void>(resolve => again.listen(0, "127.0.0.1", resolve));
    const second = again.address();
    if (second === null || typeof second === "string") throw new Error("port");
    openai.models.url = `http://127.0.0.1:${second.port}/models`;
    await fetchModelIds(openai as never, "sk-openai-synthetic");
    again.close();
    expect(seen.at(-1)?.authorization).toBe("Bearer sk-openai-synthetic");
    expect(ids).toEqual(["other-model"]);
    expect(modelMissing(ids, "sonnet-5.5@high")).toBe(true);
    expect(modelMissing(["sonnet-5.5"], "sonnet-5.5@high")).toBe(false);
    const patterns = { "sonnet-5.5": "claude-sonnet-5-5(-[0-9]{8})?" };
    expect(sameModel("sonnet-5.5", "claude-sonnet-5-5-20260901", patterns)).toBe(true);
    expect(sameModel("sonnet-5.5", "claude-sonnet-5-5-lite", patterns)).toBe(false);
    expect(sameModel("gpt-5", "gpt-5")).toBe(true);
    expect(sameModel("gpt-5", "gpt-5-mini")).toBe(false);
    expect(modelMissing(["claude-sonnet-5-5-20260901"], "sonnet-5.5@high", patterns)).toBe(false);
    expect(modelMissing(["claude-sonnet-5-5-lite"], "sonnet-5.5@high", patterns)).toBe(true);
  });

  it("lists Z.ai's GLM ids from the catalog and does not call the network", async () => {
    const body = JSON.parse(readFileSync(catalog, "utf8")) as { id: string }[];
    const preset = body.find(row => row.id === "zai");
    if (!preset) throw new Error("preset");
    const ids = await fetchModelIds(preset as never, "synthetic-zai-key", () => {
      throw new Error("network");
    });
    expect(ids).toEqual(["glm-5.3", "glm-5.3-flash"]);
    expect(modelMissing(ids, "glm-5.3@max")).toBe(false);
    expect(modelMissing(ids, "glm-4.7@high")).toBe(true);
  });
});
