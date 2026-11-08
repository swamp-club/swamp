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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { CommitStore } from "../src/domain/datastore_v3/commit_store.ts";
import {
  modelCommit,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  initializeV3Datastore,
  openV3Datastore,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  registerShutdownHandler,
  resetCommandStopForTesting,
} from "../src/infrastructure/process/shutdown_handlers.ts";
import { withV3Env } from "./datastore_v3_read_model_helpers.ts";

await initializeLogging({});

const PAGE = 10;
const TOTAL = 30;

function abortingOnSecondPage(
  store: CommitStore,
  stop: AbortController,
): CommitStore {
  let pages = 0;
  return new Proxy(store, {
    get(target, property) {
      if (property === "changesSince") {
        return (cursor: number, limit: number) => {
          if (++pages === 2) stop.abort();
          return target.changesSince(cursor, limit);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

Deno.test("read model: a catch-up stopped part way keeps what it applied, and the next one applies only the rest (swamp-club#4512)", async () => {
  await withV3Env(async (env) => {
    for (let i = 1; i <= TOTAL; i++) {
      await env.store.append(
        modelCommit(i, [await savePut(`r${i}`, 1), versionOp(`r${i}`, 1)]),
      );
    }
    const stop = new AbortController();
    const interrupted = env.openReadModel({
      commitStore: abortingOnSecondPage(env.store, stop),
      pageSize: PAGE,
      netReplay: false,
    });
    try {
      await assertRejects(() => interrupted.catchUp(stop.signal));
    } finally {
      await interrupted.close();
    }

    const resumed = env.openReadModel({ pageSize: PAGE, netReplay: false });
    try {
      assertEquals(await resumed.catchUp(AbortSignal.timeout(30_000)), {
        applied: TOTAL - PAGE,
        cursor: TOTAL,
      });
    } finally {
      await resumed.close();
    }
  });
});

Deno.test("v3 datastore: a command told to stop ends its datastore's catch-up (swamp-club#4512)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-catch-up-stop-" });
  resetCommandStopForTesting();
  try {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const handle = openV3Datastore({
      repoDir: join(dir, "repo"),
      datastorePath,
    });
    try {
      await handle.catchUp();
      const stopRequests: (() => void)[] = [];
      const shutdown = registerShutdownHandler({
        handler: () => {},
        forceExitOnRepeat: true,
        stopsCatchUps: true,
      }, {
        os: "windows",
        listenForStopRequests: (handler) => {
          stopRequests.push(handler);
          return () => {};
        },
        exit: () => {},
      });
      try {
        stopRequests[0]();
        await assertRejects(() => handle.catchUp(), DOMException);
      } finally {
        shutdown.dispose();
      }
    } finally {
      await handle.close();
    }
  } finally {
    resetCommandStopForTesting();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
