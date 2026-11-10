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
import { assert, assertEquals, assertRejects } from "@std/assert";
import { walk } from "@std/fs";
import { dirname } from "@std/path";
import { UserError } from "../src/domain/errors.ts";
import {
  CATCH_UP_UNREACHABLE_CODE,
  RECOVERY_FAILED_CODE,
} from "../src/domain/datastore_v3/read_model.ts";
import { V3_STORAGE_UNREACHABLE_CODE } from "../src/domain/datastore_v3/writer_lease.ts";
import { SERVE_NOT_LEADER_CODE } from "../src/domain/datastore_v3/serve_leader.ts";
import { writerMarkerPath } from "../src/infrastructure/datastore_v3/interrupted_writer_recovery.ts";
import {
  SERVE_DATASTORE_LOG_HEADER,
  setServeReadRefusalBudgetForTesting,
} from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import { thisKernelIdentity } from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { exitCodeForError } from "../src/presentation/output/error_output.ts";
import {
  type Client,
  dataOf,
  json,
  latestOf,
  MEMBER,
  type Scratch,
  type Serve,
  serveEnv,
  startProxy,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";

await initializeLogging({});

const TEAM: readonly GrantSpec[] = [
  ...MEMBER,
  {
    user: "bob",
    actions: ["read", "write", "run"],
    kind: "model",
    pattern: "*",
  },
  { user: "bob", actions: ["read", "write"], kind: "data", pattern: "*" },
];

const DATA_ID = "7d0c6a8e-3b1f-4c2a-9e5d-1f2a3b4c5d6e";

/** past the inline limit, so the record is stored as a chunk */
const LARGE = "x".repeat(20_000);

/** a writer of this checkout that ended without tearing down */
async function plantInterruptedWriter(repoDir: string): Promise<string> {
  const kernel = await thisKernelIdentity();
  const path = writerMarkerPath(repoDir);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      hostname: Deno.hostname(),
      pid: 4242,
      process: { ...kernel, host: `${kernel.host}#pid:[4026532999]` },
      since: 0,
    }),
  );
  return path;
}

/** as an interrupted writer leaves it: the file no longer holds the commit */
async function tearRecordFile(repoDir: string): Promise<void> {
  for await (const entry of walk(repoDir, { includeDirs: false })) {
    if (entry.isSymlink) continue;
    const text = await Deno.readTextFile(entry.path).catch(() => "");
    if (!text.includes(LARGE)) continue;
    await Deno.writeTextFile(entry.path, text.slice(0, 100));
    return;
  }
  throw new Error(`No file in ${repoDir} holds the chunked record`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function isChunkRead(request: Request): boolean {
  return request.method === "GET" &&
    new URL(request.url).pathname.includes("/chunks/");
}

async function notLeader(forward: () => Promise<Response>): Promise<Response> {
  const served = await forward();
  await served.body?.cancel();
  return Response.json(
    { code: SERVE_NOT_LEADER_CODE, message: "not the leader" },
    {
      status: 503,
      headers: {
        "Retry-After": "5",
        [SERVE_DATASTORE_LOG_HEADER]:
          served.headers.get(SERVE_DATASTORE_LOG_HEADER) ?? "",
      },
    },
  );
}

/**
 * bob writes a chunked record that alice reads, then alice's checkout is left
 * with an interrupted writer, so her next writing command replays the feed and
 * reads bob's chunk from serve again
 */
async function interruptedMember(
  scratch: Scratch,
  serve: Serve,
  proxyOrigin: string,
): Promise<{ alice: Client; env: Record<string, string | undefined> }> {
  const bob = await scratch.client("b");
  const alice = await scratch.client("a");
  const env = serveEnv({ origin: proxyOrigin }, "alice-token");
  await writeCommand(
    scratch,
    bob,
    serveEnv(serve, "bob-token"),
    async (repos) => {
      await repos.unifiedDataRepo.save(
        serve.modelType,
        serve.models.web,
        dataOf("big", DATA_ID),
        json({ by: "bob", pad: LARGE }),
      );
    },
  );
  assertEquals(
    await writeCommand(
      scratch,
      alice,
      env,
      async (repos) =>
        (await latestOf(repos, serve.modelType, serve.models.web, "big"))
          ?.version,
    ),
    1,
  );
  await plantInterruptedWriter(alice.repoDir);
  await tearRecordFile(alice.repoDir);
  return { alice, env };
}

async function saveSmall(
  scratch: Scratch,
  serve: Serve,
  alice: Client,
  env: Record<string, string | undefined>,
): Promise<number> {
  return await writeCommand(
    scratch,
    alice,
    env,
    async (repos) =>
      (await repos.unifiedDataRepo.save(
        serve.modelType,
        serve.models.web,
        dataOf("small"),
        json({ by: "alice" }),
      )).version,
  );
}

Deno.test({
  name:
    "serve recovery: a member's recovery whose chunk reads serve refuses as not the leader rides out the refusal and completes in one command",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      let refusing = false;
      let refused = 0;
      const proxy = startProxy(serve.origin, async (request, forward) => {
        if (!refusing || !isChunkRead(request) || refused >= 2) {
          return undefined;
        }
        refused++;
        return await notLeader(forward);
      });
      try {
        const { alice, env } = await interruptedMember(
          scratch,
          serve,
          proxy.origin,
        );
        refusing = true;
        assertEquals(await saveSmall(scratch, serve, alice, env), 1);
        assertEquals(refused, 2);
        assertEquals(await exists(writerMarkerPath(alice.repoDir)), false);
      } finally {
        await proxy.close();
      }
    });
  },
});

Deno.test({
  name:
    "serve recovery: a refusal that outlasts the wait ends the command as retryable with its marker kept, and the next command completes the recovery",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      let refusing = false;
      const proxy = startProxy(
        serve.origin,
        async (request, forward) =>
          refusing && isChunkRead(request)
            ? await notLeader(forward)
            : undefined,
      );
      setServeReadRefusalBudgetForTesting(300);
      try {
        const { alice, env } = await interruptedMember(
          scratch,
          serve,
          proxy.origin,
        );
        refusing = true;
        const error = await assertRejects(() =>
          saveSmall(scratch, serve, alice, env)
        );
        assert(error instanceof UserError);
        assertEquals(error.code, CATCH_UP_UNREACHABLE_CODE);
        assertEquals(exitCodeForError(error), 75);
        assert(await exists(writerMarkerPath(alice.repoDir)));

        refusing = false;
        assertEquals(await saveSmall(scratch, serve, alice, env), 1);
        assertEquals(await exists(writerMarkerPath(alice.repoDir)), false);
      } finally {
        setServeReadRefusalBudgetForTesting(undefined);
        await proxy.close();
      }
    });
  },
});

Deno.test({
  name:
    "serve recovery: a recovery that fails for another reason carries its own code, names the commit, and offers the marker without a doubled full stop",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      let failing = false;
      const proxy = startProxy(serve.origin, async (request, forward) => {
        if (!failing || !isChunkRead(request)) return undefined;
        const served = await forward();
        await served.body?.cancel();
        return Response.json(
          { code: "internal_error", message: "The chunk store failed." },
          {
            status: 500,
            headers: {
              [SERVE_DATASTORE_LOG_HEADER]:
                served.headers.get(SERVE_DATASTORE_LOG_HEADER) ?? "",
            },
          },
        );
      });
      try {
        const { alice, env } = await interruptedMember(
          scratch,
          serve,
          proxy.origin,
        );
        failing = true;
        const error = await assertRejects(() =>
          saveSmall(scratch, serve, alice, env)
        );
        assert(error instanceof UserError);
        assertEquals(error.code, RECOVERY_FAILED_CODE);
        assertEquals(exitCodeForError(error), 1);
        assert(
          /Cannot apply commit \d+ of partition /.test(error.message),
          error.message,
        );
        assert(!error.message.includes(".."), error.message);
        assert(error.message.includes(writerMarkerPath(alice.repoDir)));
      } finally {
        await proxy.close();
      }
    });
  },
});

Deno.test({
  name:
    "serve recovery: a connection lost while the recovery reads a chunk keeps its storage-unreachable code, as before",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: TEAM });
      let cutting = false;
      const proxy = startProxy(serve.origin, async (request, forward) => {
        if (!cutting || !isChunkRead(request)) return undefined;
        const served = await forward();
        const bytes = new Uint8Array(await served.arrayBuffer());
        const headers = new Headers(served.headers);
        headers.set("content-length", String(bytes.length));
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, 16));
              controller.error(new Error("connection cut"));
            },
          }),
          { status: 200, headers },
        );
      });
      try {
        const { alice, env } = await interruptedMember(
          scratch,
          serve,
          proxy.origin,
        );
        cutting = true;
        const error = await assertRejects(() =>
          saveSmall(scratch, serve, alice, env)
        );
        assert(error instanceof UserError, String(error));
        assertEquals(error.code, V3_STORAGE_UNREACHABLE_CODE);
        assertEquals(exitCodeForError(error), 75);
        assert(await exists(writerMarkerPath(alice.repoDir)));
      } finally {
        await proxy.close();
      }
    });
  },
});
