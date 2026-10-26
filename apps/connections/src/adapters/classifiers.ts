// Dialects this build can read. A name the catalog does not list has no classifier.
import type { Classifiers } from "../application/ports.ts";
import { anthropicClassifier } from "./outcome-anthropic.ts";

export const builtinClassifiers: Classifiers = {
  for(dialect: string) {
    return dialect === "anthropic" ? anthropicClassifier : null;
  },
};
