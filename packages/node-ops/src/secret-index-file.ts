// The index file adapter (design §8.1). A stub until its fix.
import { emptySecretIndex, type SecretIndex } from "./secret-scan.ts";

export type IndexFileProblem = "mode" | "owner" | "kind" | "format";
export class IndexFileRefused extends Error {
  readonly problem: IndexFileProblem;
  constructor(problem: IndexFileProblem, path: string) {
    super(`refused ${path}: ${problem}`);
    this.name = "IndexFileRefused";
    this.problem = problem;
  }
}

export function readSecretIndex(_path: string, _uid: number): SecretIndex {
  return emptySecretIndex();
}
