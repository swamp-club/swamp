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

import { assertEquals, assertRejects } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  inviteLink,
  type InviteLinkDeps,
  type InviteLinkEvent,
} from "./link.ts";

function makeDeps(overrides: Partial<InviteLinkDeps> = {}): InviteLinkDeps {
  return {
    fetchRecruitLink: () =>
      Promise.resolve({
        code: "abc123",
        url: "https://swamp.club/r/abc123",
      }),
    ...overrides,
  };
}

Deno.test("inviteLink: yields a single completed event with the recruit link", async () => {
  const ctx = createLibSwampContext({});
  const events: InviteLinkEvent[] = await collect(
    inviteLink(ctx, makeDeps(), {}),
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "completed");
  assertEquals(events[0], {
    kind: "completed",
    data: { code: "abc123", url: "https://swamp.club/r/abc123" },
  });
});

Deno.test("inviteLink: propagates a failure from the fetch dependency", async () => {
  const ctx = createLibSwampContext({});
  const deps = makeDeps({
    fetchRecruitLink: () => Promise.reject(new Error("swamp-club is down")),
  });

  await assertRejects(
    () => collect(inviteLink(ctx, deps, {})),
    Error,
    "swamp-club is down",
  );
});
