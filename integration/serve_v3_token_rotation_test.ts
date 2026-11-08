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
import { assert, assertEquals } from "@std/assert";
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
