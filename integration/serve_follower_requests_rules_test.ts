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
 * Fitness rules for serve's follower in team mode (swamp-club#4096): every
 * request type serve dispatches is either refused on a follower or answered
 * from its copy, so a new request cannot be added without deciding which.
 * Writes are refused; the reads list holds no write.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  FOLLOWER_READ_REQUESTS,
  FOLLOWER_REFUSED_REQUESTS,
} from "../src/serve/follower_requests.ts";
import { CONFIRMED_WRITE_REQUESTS } from "../src/serve/write_confirmation.ts";

const ROOT = join(import.meta.dirname!, "..");

/** The request types handleMessage's dispatch switch names. */
async function dispatchedRequests(): Promise<Set<string>> {
  const source = await Deno.readTextFile(
    join(ROOT, "src", "serve", "connection.ts"),
  );
  const start = source.indexOf("switch (request.type) {");
  assert(start > 0, "handleMessage's dispatch switch was not found");
  const end = source.indexOf("\n  }\n", start);
  assert(end > start, "handleMessage's dispatch switch has no end");
  return new Set(
    [...source.slice(start, end).matchAll(/\n {4}case "([^"]+)":/g)].map((
      match,
    ) => match[1]),
  );
}

Deno.test("follower requests: every dispatched request is refused or read, never both", async () => {
  const dispatched = await dispatchedRequests();
  assert(dispatched.size > 50, "the dispatch switch was not parsed");
  for (const type of dispatched) {
    assert(
      FOLLOWER_REFUSED_REQUESTS.has(type) !== FOLLOWER_READ_REQUESTS.has(type),
      `${type} must be in exactly one of FOLLOWER_REFUSED_REQUESTS and FOLLOWER_READ_REQUESTS`,
    );
  }
  assertEquals(
    [...FOLLOWER_READ_REQUESTS].filter((type) => !dispatched.has(type)),
    [],
    "FOLLOWER_READ_REQUESTS names a request serve no longer dispatches",
  );
});

Deno.test("follower requests: every write that waits for replication is refused", () => {
  for (const type of CONFIRMED_WRITE_REQUESTS) {
    assert(FOLLOWER_REFUSED_REQUESTS.has(type), type);
  }
});
