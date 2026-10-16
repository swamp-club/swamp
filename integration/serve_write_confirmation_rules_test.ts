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

/**
 * Fitness rules for serve's write confirmation (swamp-club#3489, Phase
 * 4D3): every write request answers only once its commits are replicated.
 * Dispatch wraps exactly the requests `CONFIRMED_WRITE_REQUESTS` names in
 * `confirmed(...)`, so a new writing request cannot be added without
 * deciding whether it waits, and the confirmation stays dormant: only
 * serve sets `confirmReplicated`, and only while replication is on.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { CONFIRMED_WRITE_REQUESTS } from "../src/serve/write_confirmation.ts";
import { SYNC_GATED_REQUESTS } from "../src/serve/sync_gate.ts";

const ROOT = join(import.meta.dirname!, "..");

/** The request types whose dispatch case wraps its handler in `confirmed`. */
async function confirmedCases(): Promise<Set<string>> {
  const source = await Deno.readTextFile(
    join(ROOT, "src", "serve", "connection.ts"),
  );
  const start = source.indexOf("switch (request.type) {");
  assert(start > 0, "handleMessage's dispatch switch was not found");
  // The switch ends at the first brace back at its own indent.
  const end = source.indexOf("\n  }\n", start);
  assert(end > start, "handleMessage's dispatch switch has no end");
  const body = source.slice(start, end);
  const cases = [...body.matchAll(/\n {4}case "([^"]+)":\n/g)];
  const wrapped = new Set<string>();
  for (const [index, match] of cases.entries()) {
    const caseEnd = cases[index + 1]?.index ?? body.length;
    if (body.slice(match.index!, caseEnd).includes("confirmed(() =>")) {
      wrapped.add(match[1]);
    }
  }
  return wrapped;
}

Deno.test("write confirmation: dispatch wraps exactly CONFIRMED_WRITE_REQUESTS", async () => {
  assertEquals(
    [...await confirmedCases()].sort(),
    [...CONFIRMED_WRITE_REQUESTS].sort(),
  );
});

Deno.test("write confirmation: every request gated for its push waits for replication", () => {
  for (const request of SYNC_GATED_REQUESTS) {
    assert(CONFIRMED_WRITE_REQUESTS.has(request), request);
  }
});

Deno.test("write confirmation: only serve sets confirmReplicated, from the datastore replicating", async () => {
  const serve = await Deno.readTextFile(
    join(ROOT, "src", "cli", "commands", "serve.ts"),
  );
  const assignment = serve.indexOf("const confirmReplicated =");
  assert(assignment > 0, "serve no longer builds confirmReplicated");
  const guard = serve.slice(assignment, serve.indexOf("?", assignment));
  assert(
    guard.includes("v3ReplicatesAt("),
    "confirmReplicated must stay undefined while the datastore does not replicate",
  );
});
