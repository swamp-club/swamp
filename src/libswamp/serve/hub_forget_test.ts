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

import { assert, assertEquals } from "@std/assert";
import { createLibSwampContext } from "../context.ts";
import { HubLink, type HubLinkInstance } from "../../domain/serve/hub_link.ts";
import {
  hubForget,
  type HubForgetDeps,
  SERVE_RUNNING_CODE,
} from "./hub_forget.ts";

const NOW = Date.parse("2026-11-26T12:10:00.000Z");

function instance(overrides: Partial<HubLinkInstance> = {}): HubLinkInstance {
  return {
    instanceId: crypto.randomUUID(),
    startedAt: "2026-11-26T12:00:00.000Z",
    aliveAt: "2026-11-26T12:09:30.000Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    result: "rejected",
    consecutiveFailures: 0,
    nextAttemptAt: null,
    stoppedAt: null,
    ...overrides,
  };
}

const MISMATCHED = HubLink.unjoined().beginJoin(
  "https://hub.example.com",
  crypto.randomUUID(),
)
  .received({
    memberId: crypto.randomUUID(),
    memberName: "edge",
    hubName: "central",
    joinedAt: "2026-11-26T12:00:00.000Z",
  }).joined().mismatch();

function deps(instances: HubLinkInstance[]) {
  const calls: string[] = [];
  const value: HubForgetDeps = {
    links: {
      readLink: () => Promise.resolve(MISMATCHED),
      listInstances: () => Promise.resolve(instances),
      clear: () => {
        calls.push("clear");
        return Promise.resolve();
      },
    },
    credentials: {
      delete: () => {
        calls.push("credential");
        return Promise.resolve();
      },
    },
    now: () => NOW,
  };
  return { value, calls };
}

async function run(d: HubForgetDeps) {
  const events = [];
  for await (const event of hubForget(createLibSwampContext(), d)) {
    events.push(event);
  }
  return events.at(-1)!;
}

Deno.test("hubForget: refused while a serve on the link is running, even a mismatched one making no requests", async () => {
  const { value, calls } = deps([instance()]);
  const last = await run(value);
  assert(last.kind === "error");
  assertEquals(last.error.code, SERVE_RUNNING_CODE);
  assertEquals(calls, []);
});

Deno.test("hubForget: forgets the credential, then the link, once every instance stopped or went quiet", async () => {
  const { value, calls } = deps([
    instance({ stoppedAt: "2026-11-26T12:09:40.000Z" }),
    instance({ aliveAt: "2026-11-26T12:07:00.000Z" }),
  ]);
  const last = await run(value);
  assert(last.kind === "completed");
  assertEquals(last.data, {
    forgot: true,
    hubUrl: "https://hub.example.com",
    memberName: "edge",
  });
  assertEquals(calls, ["credential", "clear"]);
});

Deno.test("hubForget: a link record that no longer parses is still forgotten", async () => {
  const { value, calls } = deps([]);
  const last = await run({
    ...value,
    links: { ...value.links, readLink: () => Promise.reject(new Error("bad")) },
  });
  assert(last.kind === "completed");
  assertEquals(last.data, { forgot: true, hubUrl: null, memberName: null });
  assertEquals(calls, ["credential", "clear"]);
});
