// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { basename, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { Data } from "../src/domain/data/data.ts";
import {
  MODEL_ID,
  MODEL_TYPE,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  v3RepositoryFactoryConfig,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";

await initializeLogging({});

const NAMES = ["result", "log", "summary"];

function catalogTransactions(): Disposable & {
  readonly counts: Map<string, number>;
} {
  const exec = DatabaseSync.prototype.exec;
  const counts = new Map<string, number>();
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    const path = (this as unknown as { location(): string | null })
      .location();
    const statement = sql.trim().toUpperCase();
    if (
      path !== null && basename(path) === "_catalog_v3.db" &&
      /^(BEGIN|COMMIT|ROLLBACK)/.test(statement)
    ) {
      counts.set(statement, (counts.get(statement) ?? 0) + 1);
    }
    return exec.call(this, sql);
  };
  return {
    counts,
    [Symbol.dispose]: () => {
      DatabaseSync.prototype.exec = exec;
    },
  };
}

Deno.test("v3 catalog: a quiet data write takes one catalog write transaction per data item and one to release its unit (swamp-club#5094)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-catalog-count-" });
  try {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const config = { type: "filesystem" as const, path: datastorePath };
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir);
    const write = async () => {
      await holdV3Writer(config, repoDir);
      const ctx = createRepositoryContext({
        repoDir,
        enableIndexing: false,
        ...(await v3RepositoryFactoryConfig(repoDir, config)),
      });
      const engine = ctx.commitLog;
      if (engine === undefined) {
        throw new Error("a v3 context has a commit log");
      }
      await engine.runRoot(
        { disposition: () => "commit" },
        async () => {
          for (const name of NAMES) {
            await ctx.unifiedDataRepo.save(
              MODEL_TYPE,
              MODEL_ID,
              Data.create({
                name,
                contentType: "text/plain",
                lifetime: "infinite",
                garbageCollection: 10,
                tags: { type: "resource", modelName: "counted" },
                ownerDefinition: {
                  ownerType: "model-method",
                  ownerRef: `${MODEL_TYPE.normalized}:${MODEL_ID}`,
                },
              }),
              new TextEncoder().encode(crypto.randomUUID()),
            );
          }
        },
      );
      await closeV3Datastores();
    };
    // the first write creates the files and the second's catch-up applies
    // the first's commit, so the third is a steady-state quiet write
    await write();
    await write();
    using transactions = catalogTransactions();
    await write();
    assertEquals(Object.fromEntries(transactions.counts), {
      // one upsert per data item, then the unit's release; the catch-up of
      // the previous write's commit finds its rows already stored
      "BEGIN IMMEDIATE": NAMES.length + 1,
      // the catch-up's read-only look at those rows
      "BEGIN": 1,
      "COMMIT": NAMES.length + 2,
    });
  } finally {
    await closeV3Datastores().catch(() => {});
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
