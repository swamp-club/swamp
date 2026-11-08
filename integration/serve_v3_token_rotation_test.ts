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
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { join } from "@std/path";
import {
  SERVE_UPSTREAM_STATE_FILE,
  ServeUpstreamState,
} from "../src/infrastructure/datastore_v3/serve_upstream_state.ts";
import { V3_LOCAL_COPIES_DIR } from "../src/infrastructure/datastore_v3/v3_datastore_binding.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withCapturedSpans } from "../src/infrastructure/tracing/span_test_helpers.ts";
import {
  dataOf,
  json,
  MEMBER,
  type Serve,
  serveEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { Client, Scratch } from "./serve_upstream_fixtures.ts";

await initializeLogging({});

const RECOVER = "swamp.datastore.v3.readmodel.recover";

/** one save as `token`; the names of the recover spans the command made */
async function saveAs(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  token: string,
  label: string,
): Promise<string[]> {
  let recovers: string[] = [];
  await withCapturedSpans(async (spans) => {
    await writeCommand(
      scratch,
      client,
      serveEnv(serve, token),
      (repos) =>
        repos.unifiedDataRepo.save(
          serve.modelType,
          serve.models.web,
          dataOf("out", crypto.randomUUID()),
          json({ by: label }),
        ),
    );
    recovers = spans.filter((span) => span.name === RECOVER).map((span) =>
      String(span.attributes["swamp.datastore.v3.readmodel.recover.entry"])
    );
  });
  return recovers;
}

Deno.test({
  name:
    "serve upstream: a rotated token of the same principal keeps the checkout's copy and view, while another principal's token rebuilds it (swamp-club#4512)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({
        grants: [
          ...MEMBER,
          {
            user: "bob",
            actions: ["read", "write", "run"],
            kind: "model",
            pattern: "*",
          },
          {
            user: "bob",
            actions: ["read", "write"],
            kind: "data",
            pattern: "*",
          },
        ],
      });
      const alice = await scratch.client("a");
      await saveAs(scratch, serve, alice, "alice-token", "first");
      await saveAs(scratch, serve, alice, "alice-token", "second");
      assertEquals(
        await saveAs(scratch, serve, alice, "alice-rotated-token", "rotated"),
        [],
        "a rotated token of the same principal runs no recovery",
      );
      const other = await saveAs(scratch, serve, alice, "bob-token", "bob");
      assert(
        other.includes("view_change"),
        `another principal rebuilds the view: ${other.join(",")}`,
      );
    });
  },
});

async function copyIdOf(repoDir: string): Promise<string> {
  const copies = swampPath(repoDir, V3_LOCAL_COPIES_DIR);
  for await (const entry of Deno.readDir(copies)) {
    if (!entry.isDirectory || !entry.name.startsWith("serve-")) continue;
    const state = ServeUpstreamState.open(
      join(copies, entry.name, SERVE_UPSTREAM_STATE_FILE),
    );
    try {
      return state.copyId();
    } finally {
      state.close();
    }
  }
  throw new Error(`no serve copy under ${copies}`);
}

Deno.test({
  name:
    "serve upstream: serve names no principal for a revoked token, and rotating to one resets the copy instead of keeping it (swamp-club#4512)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const reply = await fetch(
        `${serve.origin}/api/v1/datastore/_default/changes?cursor=0&limit=1`,
        { headers: { authorization: "Bearer revoked-token" } },
      );
      await reply.body?.cancel();
      assertEquals(reply.status, 401);
      assertEquals(reply.headers.get("x-swamp-datastore-principal"), null);

      const alice = await scratch.client("a");
      await saveAs(scratch, serve, alice, "alice-token", "first");
      await saveAs(scratch, serve, alice, "alice-token", "second");
      const before = await copyIdOf(alice.repoDir);
      await assertRejects(() =>
        saveAs(scratch, serve, alice, "revoked-token", "revoked")
      );
      assertNotEquals(
        await copyIdOf(alice.repoDir),
        before,
        "the copy was reset for the revoked token",
      );
    });
  },
});
