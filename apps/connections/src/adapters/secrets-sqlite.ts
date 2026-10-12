// The node's Secrets in the Connections database (design §6, "Metadata"). Not built yet: the signatures only.
import type Database from "better-sqlite3";
import { openPrivateDb } from "@morndo/service-kit";
import { emptySecretDirectory } from "@morndo/domain";
import type { SecretsDirectory, SecretsState } from "../application/ports.ts";
import { DatabaseFromFuture, MIGRATIONS, migrate } from "./store-migrations.ts";

type SecretsHooks = { beforeSave?: () => void };

export class SqliteSecrets implements SecretsDirectory {
  readonly #db: Database.Database;

  constructor(path: string, uid?: number, hooks?: SecretsHooks) {
    void uid;
    void hooks;
    this.#db = openPrivateDb(path, {
      synchronous: "NORMAL",
      knownVersion: MIGRATIONS.length,
      refuseNewer: (found, known) => new DatabaseFromFuture(found, known),
      migrate: db => { migrate(db); },
    });
  }

  load(): SecretsState {
    return { directory: emptySecretDirectory(), vaults: [], workspaces: [] };
  }

  write<T>(change: (state: SecretsState) => { next: SecretsState | null; result: T }): T {
    return change(this.load()).result;
  }

  close(): void {
    this.#db.close();
  }
}
