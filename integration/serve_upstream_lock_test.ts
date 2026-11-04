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
import { Command } from "@cliffy/command";
import { datastoreLockCommand } from "../src/cli/commands/datastore_lock.ts";
import { datastoreStatusCommand } from "../src/cli/commands/datastore_status.ts";
import {
  resetImplicitServeRouting,
  setImplicitServeRouting,
} from "../src/cli/remote_run.ts";
import { serveUpstreamRunsLocally } from "../src/cli/serve_upstream.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import {
  type Client,
  endCommand,
  latestOf,
  readCommand,
  type Scratch,
  type Serve,
  serveEnv,
  withClientEnv,
  withScratch,
} from "./serve_upstream_fixtures.ts";
import type {
  ClientWorkerMessage,
  ClientWorkerRequest,
} from "./serve_upstream_client_worker.ts";

await initializeLogging({});

const DATA_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a31";
const PER_CLIENT = 10;
/**
 * saves each side makes when a machine and serve's own runs interleave: enough
 * that, without serve's lock, some overlap
 */
const INTERLEAVED = 20;

interface Written {
  readonly versions: readonly number[];
  readonly errors: readonly string[];
}

function runClient(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  label: string,
  count: number,
): Promise<Written> {
  return startClient(scratch, serve, client, label, count).finished;
}

function startClient(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  label: string,
  count: number,
): { started: Promise<void>; finished: Promise<Written> } {
  const worker = new Worker(
    new URL("./serve_upstream_client_worker.ts", import.meta.url).href,
    { type: "module" },
  );
  let loaded = false;
  let done: Extract<ClientWorkerMessage, { kind: "done" }> | undefined;
  let failed: string | undefined;
  worker.onmessage = (event: MessageEvent<ClientWorkerMessage>) => {
    const message = event.data;
    if (message.kind === "loaded") loaded = true;
    else if (message.kind === "done") done = message;
    else failed = message.error;
  };
  worker.onerror = (event) => {
    event.preventDefault();
    failed = event.message;
  };
  const started = (async () => {
    await waitFor(
      () => loaded || failed !== undefined,
      `client ${label}'s worker to load`,
      { timeoutMs: 120_000 },
    );
    worker.postMessage(
      {
        kind: "run",
        configDir: scratch.configDir,
        repoDir: client.repoDir,
        // under load one request contending with serve's runs outlasts 30s
        env: {
          ...serveEnv(serve, "alice-token"),
          SWAMP_SERVE_TIMEOUT_MS: "120000",
        },
        modelType: serve.modelType.normalized,
        modelId: serve.models.web,
        dataName: "out",
        dataId: DATA_ID,
        count,
        label,
      } satisfies ClientWorkerRequest,
    );
  })();
  const finished = (async () => {
    try {
      await started;
      await waitFor(
        () => done !== undefined || failed !== undefined,
        `client ${label}'s commands`,
        { timeoutMs: 180_000, intervalMs: 50 },
      );
    } finally {
      worker.terminate();
    }
    if (done === undefined) {
      throw new Error(`client ${label} failed: ${failed}`);
    }
    return done;
  })();
  // Awaited by `finished`'s caller; a load failure rejects both.
  started.catch(() => {});
  return { started, finished };
}

async function landedVersions(serve: Serve): Promise<number[]> {
  const versions = new Set<number>();
  for (const entry of await serve.log()) {
    for (const key of entry.keys) {
      const match = key.match(/\/out\/(\d+)\/raw$/);
      if (match !== null) versions.add(Number(match[1]));
    }
  }
  return [...versions].sort((a, b) => a - b);
}

function oneTo(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

async function latestIn(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  type: ModelType,
): Promise<number | undefined> {
  return (await readCommand(
    scratch,
    client,
    serveEnv(serve, "alice-token"),
    (repos) => latestOf(repos, type, serve.models.web, "out"),
  ))?.version;
}

Deno.test({
  name:
    "serve upstream locks: two machines writing one behavior's data at once under its lock all land, versions distinct and contiguous",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const a = await scratch.client("a");
      const b = await scratch.client("b");
      const [fromA, fromB] = await Promise.all([
        runClient(scratch, serve, a, "a", PER_CLIENT),
        runClient(scratch, serve, b, "b", PER_CLIENT),
      ]);
      assertEquals([...fromA.errors, ...fromB.errors], []);
      const saved = [...fromA.versions, ...fromB.versions].sort((x, y) =>
        x - y
      );
      assertEquals(saved, oneTo(2 * PER_CLIENT));
      assertEquals(await landedVersions(serve), oneTo(2 * PER_CLIENT));
      assertEquals(
        await latestIn(scratch, serve, a, serve.modelType),
        2 * PER_CLIENT,
      );
      assertEquals(
        await latestIn(scratch, serve, b, serve.modelType),
        2 * PER_CLIENT,
      );
    });
  },
});

Deno.test({
  name:
    "serve upstream locks: a machine's writes and serve's own runs on one behavior exclude each other",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const a = await scratch.client("a");
      // Serve's runs start once the client's worker is loaded, so the two
      // overlap.
      const client = startClient(scratch, serve, a, "a", INTERLEAVED);
      await client.started;
      const [fromA, fromServe] = await Promise.all([
        client.finished,
        serve.write("out", DATA_ID, INTERLEAVED),
      ]);
      assertEquals([...fromA.errors, ...fromServe.errors], []);
      const saved = [...fromA.versions, ...fromServe.versions].sort((x, y) =>
        x - y
      );
      assertEquals(saved, oneTo(2 * INTERLEAVED));
      assertEquals(await landedVersions(serve), oneTo(2 * INTERLEAVED));
    });
  },
});

/** the JSON documents a command printed, one per console.log call */
async function datastoreCommandJson(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  args: readonly string[],
): Promise<unknown[]> {
  const root = new Command()
    .globalOption("--json", "JSON output")
    .command(
      "datastore",
      new Command()
        .command("lock", datastoreLockCommand)
        .command("status", datastoreStatusCommand),
    );
  const printed: unknown[] = [];
  // As startup does for a format-3 checkout.
  setImplicitServeRouting(
    !serveUpstreamRunsLocally(["datastore", ...args.slice(0, 1)]),
  );
  const log = console.log;
  console.log = (...values: unknown[]) => {
    printed.push(JSON.parse(values.map(String).join(" ")));
  };
  try {
    await withClientEnv(
      scratch,
      serveEnv(serve, "alice-token"),
      ["datastore", ...args.slice(0, 1)],
      () =>
        root.parse([
          "datastore",
          ...args,
          "--json",
          "--repo-dir",
          client.repoDir,
        ]),
    );
  } finally {
    console.log = log;
    resetImplicitServeRouting();
    await endCommand();
  }
  return printed;
}

Deno.test({
  name:
    "serve upstream locks: a member on a bucket reads lock status, releases and reports health through serve, never its storage (swamp-club#4281)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const bucket = scratch.bucket();
      const member = await scratch.client("a", { bucket });

      const status = await datastoreCommandJson(scratch, serve, member, [
        "lock",
        "status",
      ]);
      assertEquals(status.at(-1), {
        held: false,
        datastoreType: bucket.typeName,
      });

      const released = await datastoreCommandJson(scratch, serve, member, [
        "lock",
        "release",
        "--force",
      ]);
      assertEquals(released, [{ released: false, reason: "no lock held" }]);

      const health = await datastoreCommandJson(scratch, serve, member, [
        "status",
      ]);
      const reported = health.at(-1) as Record<string, unknown>;
      assertEquals(reported.healthy, true, JSON.stringify(reported));
      assertEquals(reported.type, bucket.typeName);

      assertEquals(bucket.touched(), []);
    });
  },
});
