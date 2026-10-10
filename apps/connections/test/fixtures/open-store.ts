import { SqliteStore } from "../../src/adapters/store-sqlite.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: open-store.ts <db>");
const store = new SqliteStore(file);
store.load();
store.close();
