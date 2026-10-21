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

import { assertEquals, assertStrictEquals } from "@std/assert";
import { type ApplyReply, createRequestRunner } from "./request_runner.ts";

/** A request the test answers itself, counting how often it was sent. */
function controlledRequest() {
  const replies: PromiseWithResolvers<string>[] = [];
  return {
    replies,
    start: () => {
      const reply = Promise.withResolvers<string>();
      replies.push(reply);
      return reply.promise;
    },
  };
}

/** Records what reached the hook's state. */
function recorder(label = ""): ApplyReply<string> & { applied: string[] } {
  const applied: string[] = [];
  return {
    applied,
    result: (value) => applied.push(`${label}${value}`),
    error: (err) => applied.push(`${label}error:${(err as Error).message}`),
  };
}

Deno.test("createRequestRunner: send applies the reply and resolves", async () => {
  const runner = createRequestRunner();
  const req = controlledRequest();
  const apply = recorder();
  const settled = runner.send(req.start, apply);
  req.replies[0].resolve("v1");
  await settled;
  assertEquals(apply.applied, ["v1"]);
});

Deno.test("createRequestRunner: send applies a failure and still resolves", async () => {
  const runner = createRequestRunner();
  const req = controlledRequest();
  const apply = recorder();
  const settled = runner.send(req.start, apply);
  req.replies[0].reject(new Error("slow"));
  await settled;
  assertEquals(apply.applied, ["error:slow"]);
});

Deno.test("createRequestRunner: a start that throws resolves and applies the error", async () => {
  const runner = createRequestRunner();
  const apply = recorder();
  await runner.send(() => {
    throw new Error("Not connected");
  }, apply);
  assertEquals(apply.applied, ["error:Not connected"]);
});

Deno.test("createRequestRunner: a late reply to a superseded request is dropped", async () => {
  const runner = createRequestRunner();
  const req = controlledRequest();
  const apply = recorder();
  const first = runner.send(req.start, apply);
  const second = runner.send(req.start, apply);
  // The second reply lands first, then the first one arrives late.
  req.replies[1].resolve("v5");
  await second;
  req.replies[0].resolve("v4");
  await first;
  assertEquals(apply.applied, ["v5"]);
});

Deno.test("createRequestRunner: join waits for the request in flight", async () => {
  const runner = createRequestRunner();
  const req = controlledRequest();
  const apply = recorder();
  const sent = runner.send(req.start, apply);
  const joined = runner.join(req.start, recorder("joined:"));
  assertStrictEquals(joined, sent);
  assertEquals(req.replies.length, 1);
  req.replies[0].resolve("v1");
  await joined;
  assertEquals(apply.applied, ["v1"]);
});

Deno.test("createRequestRunner: join starts a request when none is in flight", async () => {
  const runner = createRequestRunner();
  const req = controlledRequest();
  const apply = recorder();
  const joined = runner.join(req.start, apply);
  assertEquals(req.replies.length, 1);
  req.replies[0].resolve("v1");
  await joined;
  assertEquals(apply.applied, ["v1"]);
});

Deno.test("createRequestRunner: join after the request settles starts a new one", async () => {
  const runner = createRequestRunner();
  const req = controlledRequest();
  const apply = recorder();
  const first = runner.send(req.start, apply);
  req.replies[0].resolve("v1");
  await first;
  const second = runner.join(req.start, apply);
  assertEquals(req.replies.length, 2);
  req.replies[1].resolve("v2");
  await second;
  assertEquals(apply.applied, ["v1", "v2"]);
});

Deno.test("createRequestRunner: join after a send joins the newer request", async () => {
  const runner = createRequestRunner();
  const req = controlledRequest();
  const apply = recorder();
  const first = runner.send(req.start, apply);
  const second = runner.send(req.start, apply);
  assertStrictEquals(runner.join(req.start, apply), second);
  assertEquals(req.replies.length, 2);
  req.replies[0].resolve("v4");
  req.replies[1].resolve("v5");
  await Promise.all([first, second]);
  assertEquals(apply.applied, ["v5"]);
});

Deno.test("createRequestRunner: a superseded request settling keeps the newer one joinable", async () => {
  const runner = createRequestRunner();
  const req = controlledRequest();
  const apply = recorder();
  const first = runner.send(req.start, apply);
  const second = runner.send(req.start, apply);
  req.replies[0].resolve("v4");
  await first;
  assertStrictEquals(runner.join(req.start, apply), second);
  assertEquals(req.replies.length, 2);
  req.replies[1].resolve("v5");
  await second;
});

Deno.test("createRequestRunner: invalidate drops the request in flight", async () => {
  const runner = createRequestRunner();
  const req = controlledRequest();
  const stale = recorder("stale:");
  const fresh = recorder("fresh:");
  const first = runner.send(req.start, stale);
  runner.invalidate();
  const second = runner.join(req.start, fresh);
  assertEquals(req.replies.length, 2);
  req.replies[0].resolve("v1");
  req.replies[1].resolve("v2");
  await Promise.all([first, second]);
  assertEquals(stale.applied, []);
  assertEquals(fresh.applied, ["fresh:v2"]);
});
