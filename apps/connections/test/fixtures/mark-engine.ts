import { FileEngines } from "../../src/adapters/engines-file.ts";

const path = process.argv[2];
const name = process.argv[3];
if (!path || !name) throw new Error("usage: mark-engine.ts <file> <name>");
new FileEngines(path).mark(name, "model missing", 1);
