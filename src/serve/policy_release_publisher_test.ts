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
import { PolicyRelease } from "../domain/access/policy_release.ts";
import type { Grant } from "../domain/models/access/grant_model.ts";
import { PolicyReleasePublisher } from "./policy_release_publisher.ts";

function release(id: string, writeImpliesTag = true): PolicyRelease {
  const grant: Grant = {
    id,
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
  return PolicyRelease.of({
    grants: [grant],
    groups: [],
    knownGrants: new Map(),
    knownGroups: new Map(),
    decisions: {
      runImpliesApprove: true,
      runImpliesSignal: true,
      writeImpliesTag,
    },
  });
}

function harness(options: { fence?: () => number | undefined } = {}) {
  const written: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  let failures = 0;
  const publisher = new PolicyReleasePublisher({
    fence: options.fence ?? (() => 1),
    write: async (r) => {
      await gate;
      if (failures > 0) {
        failures--;
        throw new Error("storage unreachable");
      }
      written.push(r.grants[0].id);
    },
    retryDelayMs: () => 1,
  });
  return {
    publisher,
    written,
    hold() {
      let open = () => {};
      gate = new Promise((resolve) => open = resolve);
      return () => open();
    },
    failNext(count: number) {
      failures = count;
    },
  };
}

Deno.test("PolicyReleasePublisher: offering never waits for the write, and the newest offer wins", async () => {
  const h = harness();
  const open = h.hold();
  h.publisher.offer(release("a"));
  // the offer returned while its write is held
  assertEquals(h.written, []);
  await Promise.resolve();
  h.publisher.offer(release("b"));
  h.publisher.offer(release("c"));
  open();
  await h.publisher.settled();
  // "a" may or may not have been taken before the later offers; "b" never lands
  assertEquals(h.written.at(-1), "c");
  assertEquals(h.written.includes("b"), false);
  await h.publisher.stop();
});

Deno.test("PolicyReleasePublisher: an unchanged policy under the same fence writes nothing; a new fence writes it again", async () => {
  let fence = 1;
  const h = harness({ fence: () => fence });
  h.publisher.offer(release("a"));
  await h.publisher.settled();
  h.publisher.offer(release("a"));
  await h.publisher.settled();
  assertEquals(h.written, ["a"]);
  h.publisher.offer(release("a", false));
  await h.publisher.settled();
  assertEquals(h.written.length, 2);
  fence = 2;
  h.publisher.offer(release("a", false));
  await h.publisher.settled();
  assertEquals(h.written.length, 3);
  await h.publisher.stop();
});

Deno.test("PolicyReleasePublisher: a failed write is retried until it lands", async () => {
  const h = harness();
  h.failNext(3);
  h.publisher.offer(release("a"));
  await h.publisher.settled();
  assertEquals(h.written, ["a"]);
  await h.publisher.stop();
});

Deno.test("PolicyReleasePublisher: a process that does not hold the lease writes nothing", async () => {
  const h = harness({ fence: () => undefined });
  h.publisher.offer(release("a"));
  await h.publisher.settled();
  assertEquals(h.written, []);
  await h.publisher.stop();
});

Deno.test("PolicyReleasePublisher: a retry stops when the lease is lost", async () => {
  let fence: number | undefined = 1;
  const h = harness({ fence: () => fence });
  h.failNext(1_000);
  h.publisher.offer(release("a"));
  fence = undefined;
  await h.publisher.settled();
  assertEquals(h.written, []);
  await h.publisher.stop();
});
