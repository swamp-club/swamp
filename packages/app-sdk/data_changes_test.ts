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
import type { DataChangesPage } from "../client/client.ts";
import type { DataSubscribePayload } from "../client/protocol.ts";
import { SwampClientError } from "../client/stream.ts";
import {
  type DataChangesMode,
  type FollowDataChanges,
  followDataChanges,
} from "./data_changes.ts";

const page = (cursor: number, names: string[] = []): DataChangesPage => ({
  kind: "changes",
  cursor,
  head: cursor,
  done: false,
  changes: names.map((name) => ({
    cursor,
    at: "2026-11-17T00:00:00Z",
    behavior: "board",
    type: "@kanban/board",
    name,
    version: 1,
    change: "saved",
  })),
});

/** Plays one script per subscribe call, then stops the follow. */
function harness(
  scripts:
    ((payload: DataSubscribePayload) => AsyncIterable<DataChangesPage>)[],
) {
  const controller = new AbortController();
  const calls: DataSubscribePayload[] = [];
  const seen: string[] = [];
  const modes: DataChangesMode[] = [];
  let stale = 0;
  let waits = 0;
  const follow: FollowDataChanges = {
    filter: { behaviors: ["board"] },
    signal: controller.signal,
    pollMs: 10,
    subscribe(payload) {
      calls.push(payload);
      const script = scripts[calls.length - 1];
      if (script === undefined) {
        controller.abort();
        return (async function* () {})();
      }
      return script(payload);
    },
    onChanges: (p) => seen.push(...p.changes.map((c) => c.name)),
    onStale: () => {
      stale++;
      if (stale >= 3) controller.abort();
    },
    onMode: (mode) => modes.push(mode),
    wait: () => {
      waits++;
      return Promise.resolve();
    },
  };
  return {
    run: () => followDataChanges(follow),
    calls,
    seen,
    modes,
    stale: () => stale,
    waits: () => waits,
  };
}

const fail = (code: string) => (): AsyncIterable<DataChangesPage> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.reject(new SwampClientError(code, code)),
  }),
});

Deno.test("followDataChanges: passes on pages with changes and skips heartbeats", async () => {
  const h = harness([async function* () {
    yield page(1);
    yield page(2, ["ticket-a"]);
    yield page(3);
    yield page(4, ["ticket-b"]);
    throw new SwampClientError("serve_not_leader", "gone");
  }]);
  await h.run();
  assertEquals(h.seen, ["ticket-a", "ticket-b"]);
  assertEquals(h.calls[0], { behaviors: ["board"] });
});

Deno.test("followDataChanges: a dropped stream resubscribes from the last cursor", async () => {
  const h = harness([
    async function* () {
      yield page(5, ["ticket-a"]);
      throw new SwampClientError("commits_lagged", "lagged");
    },
    async function* () {
      yield page(9, ["ticket-b"]);
    },
  ]);
  await h.run();
  assertEquals(h.calls[1], { behaviors: ["board"], cursor: 5 });
  assertEquals(h.seen, ["ticket-a", "ticket-b"]);
  assertEquals(h.stale(), 0);
});

Deno.test("followDataChanges: a compacted gap starts afresh and says data may have changed", async () => {
  const h = harness([
    async function* () {
      yield page(5);
      throw new SwampClientError("commits_compacted", "compacted");
    },
    async function* () {
      yield page(40);
    },
  ]);
  await h.run();
  assertEquals(h.calls[1], { behaviors: ["board"] });
  assertEquals(h.stale(), 1);
});

Deno.test("followDataChanges: a serve with no change feed is polled instead", async () => {
  const h = harness([fail("data_feed_unavailable")]);
  await h.run();
  assertEquals(h.modes, ["polling"]);
  assertEquals(h.stale(), 3);
  assertEquals(h.calls.length, 1);
});

Deno.test("followDataChanges: a local dashboard that cannot subscribe is polled instead", async () => {
  const h = harness([fail("not_available_locally")]);
  await h.run();
  assertEquals(h.modes, ["polling"]);
  assertEquals(h.stale(), 3);
  assertEquals(h.calls.length, 1);
});
