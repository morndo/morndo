export function streamRedactor(secrets: readonly string[]): { push(chunk: string): string; flush(): string; add(secrets: readonly string[]): void } {
  const needles = secrets.filter(secret => secret !== "");
  let tail = needles.reduce((longest, secret) => Math.max(longest, secret.length - 1), 0);
  let pending = "";
  const next = (): { at: number; secret: string } | null => {
    let found: { at: number; secret: string } | null = null;
    for (const secret of needles) {
      const at = pending.indexOf(secret);
      if (at >= 0 && (found === null || at < found.at)) found = { at, secret };
    }
    return found;
  };
  return {
    add(more: readonly string[]): void {
      for (const secret of more) if (secret !== "") needles.push(secret);
      tail = needles.reduce((longest, secret) => Math.max(longest, secret.length - 1), 0);
    },
    push(chunk: string): string {
      pending += chunk;
      let out = "";
      for (let hit = next(); hit; hit = next()) {
        out += pending.slice(0, hit.at) + "[redacted]";
        pending = pending.slice(hit.at + hit.secret.length);
      }
      if (pending.length > tail) {
        out += pending.slice(0, pending.length - tail);
        pending = pending.slice(pending.length - tail);
      }
      return out;
    },
    flush(): string {
      const rest = needles.reduce((out, secret) => out.split(secret).join("[redacted]"), pending);
      pending = "";
      return rest;
    },
  };
}
