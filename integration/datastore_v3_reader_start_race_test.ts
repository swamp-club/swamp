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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  alignCheckoutView,
  type CheckoutView,
} from "../src/infrastructure/datastore_v3/checkout_view.ts";
import { ReadModelState } from "../src/infrastructure/datastore_v3/read_model_state.ts";
import type { V3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { acquireV3WriterLock } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import type {
  StartRaceMessage,
  StartRaceRequest,
} from "./datastore_v3_reader_start_race_worker.ts";

const SERVE: CheckoutView = {
  kind: "serve",
  root: "/repo/.swamp/_datastore_v3_copies/serve-1",
  copy: "c".repeat(32),
  caller: "a".repeat(64),
  serverUrl: "http://serve.example.com",
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-start-race-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function startOther(request: StartRaceRequest) {
  const messages: StartRaceMessage[] = [];
  const worker = new Worker(
    new URL("./datastore_v3_reader_start_race_worker.ts", import.meta.url).href,
    { type: "module" },
  );
  worker.onmessage = (event: MessageEvent<StartRaceMessage>) => {
    messages.push(event.data);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    messages.push({ failed: event.message });
  };
  worker.postMessage(request);
  const seen = (
    test: (m: StartRaceMessage) => boolean,
    description: string,
    // a first message waits on the worker loading its whole module graph
    timeoutMs = 120_000,
  ) =>
    waitFor(
      () => messages.some(test) || messages.some((m) => "failed" in m),
      description,
      { timeoutMs },
    ).then(() => {
      const failed = messages.find((m) => "failed" in m);
      if (failed !== undefined && "failed" in failed) {
        throw new Error(`the other process failed: ${failed.failed}`);
      }
      return messages.find(test)!;
    });
  return { worker, seen };
}

Deno.test("alignCheckoutView: a reader waiting for the lease reads once the writer holding it for its whole command has aligned the view", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    const repoDir = join(dir, "repo");
    await Deno.mkdir(datastorePath);
    await Deno.mkdir(repoDir);
    const releaseLease = await acquireV3WriterLock(datastorePath, {
      maxWaitMs: 0,
    });
    const reader = startOther({
      kind: "align",
      repoDir,
      datastorePath,
      view: SERVE,
    });
    try {
      await reader.seen(
        (m) => "waiting" in m,
        "the reader waiting for the lease",
      );
      let writerRebuilds = 0;
      const writer = {
        datastorePath,
        recoverInterruptedWriter() {
          writerRebuilds++;
          return Promise.resolve([]);
        },
      } as unknown as V3Datastore;
      await alignCheckoutView(repoDir, writer, SERVE, {
        holdsWriterLock: true,
      });
      const aligned = await reader.seen(
        (m) => "aligned" in m,
        "the reader aligned while the writer still holds the lease",
        60_000,
      );
      assertEquals(writerRebuilds, 1);
      assertEquals("aligned" in aligned ? aligned.aligned : undefined, 0);
    } finally {
      reader.worker.terminate();
      await releaseLease();
    }
  });
});

Deno.test("ReadModelState.open: a new database another process is switching or migrating is opened once its write lock goes", async () => {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, "read_model.db");
    const holder = startOther({ kind: "hold", dbPath, holdMs: 300 });
    try {
      await holder.seen(
        (m) => "locked" in m,
        "the other connection's write lock",
      );
      holder.worker.postMessage("release");
      const state = ReadModelState.open(dbPath);
      try {
        assertEquals(state.cursor(), 0);
      } finally {
        state.close();
      }
      await holder.seen((m) => "released" in m, "the other connection done");
    } finally {
      holder.worker.terminate();
    }
  });
});
