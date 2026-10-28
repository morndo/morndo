// The judgements of the published-feed rehearsal (adopt-checks.ts), tested without a machine or a network.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { allowedSignersLine, parsePublished } from "./adopt-checks.ts";

describe("allowedSignersLine", () => {
  const readme = [
    "```sh",
    "curl -fsSLO https://example.invalid/install.sh",
    "echo 'release@example.invalid namespaces=\"release@example.invalid\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexamplekeyexamplekeyexamplekeyexample12' > morndo.allowed_signers",
    "ssh-keygen -Y verify -f morndo.allowed_signers ...",
    "```",
  ].join("\n");
  it("is the quoted text of the README's echo line that writes morndo.allowed_signers", () => {
    expect(allowedSignersLine(readme)).toBe("release@example.invalid namespaces=\"release@example.invalid\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexamplekeyexamplekeyexamplekeyexample12");
  });
  it("is null when there is no such line, or when two different lines claim to be it", () => {
    expect(allowedSignersLine("nothing here")).toBeNull();
    expect(allowedSignersLine(`${readme}\necho 'x ssh-ed25519 AAAA' > morndo.allowed_signers\n`)).toBeNull();
  });
});

describe("parsePublished", () => {
  it("reads --published <version> from the arguments", () => {
    expect(parsePublished(["--published", "0.1.1"])).toBe("0.1.1");
    expect(parsePublished(["x", "--published", "1.20.3-rc.1"])).toBe("1.20.3-rc.1");
    expect(parsePublished([])).toBeNull();
  });
  it("refuses a missing or non-version value", () => {
    expect(() => parsePublished(["--published"])).toThrow();
    expect(() => parsePublished(["--published", "latest"])).toThrow();
    expect(() => parsePublished(["--published", "../0.1.1"])).toThrow();
  });
  it("refuses a repeated --published, whether the versions agree or not", () => {
    expect(() => parsePublished(["--published", "0.1.1", "--published", "0.2.0"])).toThrow(/once/);
    expect(() => parsePublished(["--published", "0.2.0", "--published", "0.2.0"])).toThrow(/once/);
  });
  it("with --require-published, refuses a run that names no version (it would silently run the local rehearsal)", () => {
    expect(() => parsePublished(["--require-published"])).toThrow(/--published <version>/);
    expect(parsePublished(["--require-published", "--published", "0.2.0"])).toBe("0.2.0");
  });
});

describe("the published script in package.json", () => {
  it("names no version: the caller must give --published", () => {
    const scripts = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }).scripts;
    const line = scripts["e2e:update-adopt-published"] ?? "";
    expect(line).toContain("e2e/update-adopt.e2e.ts");
    expect(line).not.toMatch(/\d+\.\d+\.\d+/);
    expect(line).toContain("--require-published");
    expect(line).not.toContain("--published ");
  });
});
