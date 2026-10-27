// The judgements of the published-feed rehearsal (adopt-checks.ts), tested without a machine or a network.
import { describe, expect, it } from "vitest";
import { allowedSignersLine, parsePublished, sha256For } from "./adopt-checks.ts";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

describe("sha256For", () => {
  it("reads the hash of a named file from SHA256SUMS (text and binary separators)", () => {
    const sums = `${H1}  morndo-0.1.1-linux-arm64.tar.gz\n${H2} *morndo-0.1.1-linux-x64.tar.gz\n`;
    expect(sha256For(sums, "morndo-0.1.1-linux-x64.tar.gz")).toBe(H2);
    expect(sha256For(sums, "morndo-0.1.1-linux-arm64.tar.gz")).toBe(H1);
  });
  it("is null for a missing file, a prefix of a name, or a malformed hash", () => {
    expect(sha256For(`${H1}  morndo-0.1.1-linux-x64.tar.gz\n`, "morndo-0.1.1-linux")).toBeNull();
    expect(sha256For(`${H1}  other.tar.gz\n`, "morndo-0.1.1-linux-x64.tar.gz")).toBeNull();
    expect(sha256For("zzzz  morndo-0.1.1-linux-x64.tar.gz\n", "morndo-0.1.1-linux-x64.tar.gz")).toBeNull();
    expect(sha256For("", "x")).toBeNull();
  });
});

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
});
