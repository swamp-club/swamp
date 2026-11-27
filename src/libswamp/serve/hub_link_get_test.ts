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
import { hubLinkGet } from "./hub_link_get.ts";

const MEMBER_ID = crypto.randomUUID();

function instance(): HubLinkInstance {
  return {
    instanceId: crypto.randomUUID(),
    startedAt: "2026-11-26T12:00:00.000Z",
    aliveAt: "2026-11-26T12:00:30.000Z",
    lastAttemptAt: "2026-11-26T12:00:30.000Z",
    lastSuccessAt: "2026-11-26T12:00:30.000Z",
    result: "ok",
    consecutiveFailures: 0,
    nextAttemptAt: "2026-11-26T12:01:00.000Z",
    stoppedAt: null,
  };
}

Deno.test("hubLinkGet: reports the link, the configured hub and every instance", async () => {
  const link = HubLink.unjoined().beginJoin(
    "https://hub.example.com",
    crypto.randomUUID(),
  ).received(
    {
      memberId: MEMBER_ID,
      memberName: "edge",
      hubName: "central",
      joinedAt: "2026-11-26T12:00:00.000Z",
    },
  ).joined();
  const instances = [instance()];
  const events = [];
  for await (
    const event of hubLinkGet(createLibSwampContext(), {
      links: {
        readLink: () => Promise.resolve(link),
        listInstances: () => Promise.resolve(instances),
      },
      configuredHubUrl: "https://hub.example.com",
    })
  ) events.push(event);
  const completed = events.find((e) => e.kind === "completed");
  assert(completed?.kind === "completed");
  assertEquals(completed.data, {
    state: "joined",
    hubUrl: "https://hub.example.com",
    configuredHubUrl: "https://hub.example.com",
    hubName: "central",
    memberName: "edge",
    memberId: MEMBER_ID,
    joinedAt: "2026-11-26T12:00:00.000Z",
    instances,
  });
});

Deno.test("hubLinkGet: a store failure is an error event, never a rejection", async () => {
  const events = [];
  for await (
    const event of hubLinkGet(createLibSwampContext(), {
      links: {
        readLink: () => Promise.reject(new Error("down")),
        listInstances: () => Promise.resolve([]),
      },
      configuredHubUrl: "https://hub.example.com",
    })
  ) events.push(event);
  const error = events.find((e) => e.kind === "error");
  assert(error?.kind === "error");
  assertEquals(error.error.code, "hub_link_get_failed");
});

Deno.test("hubLinkGet: a joining link's joinId is never reported", async () => {
  const joinId = crypto.randomUUID();
  const link = HubLink.unjoined().beginJoin("https://hub.example.com", joinId);
  const events = [];
  for await (
    const event of hubLinkGet(createLibSwampContext(), {
      links: {
        readLink: () => Promise.resolve(link),
        listInstances: () => Promise.resolve([]),
      },
      configuredHubUrl: "https://hub.example.com",
    })
  ) events.push(event);
  const completed = events.find((e) => e.kind === "completed");
  assert(completed?.kind === "completed");
  assertEquals(completed.data.state, "joining");
  assert(!JSON.stringify(events).includes(joinId));
});
