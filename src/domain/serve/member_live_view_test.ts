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
import { memberLiveView } from "./member_live_view.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const RUNTIME = {
  team: { role: "leader" as const, nodes: 2 },
  startedAt: "2026-01-01T00:00:00.000Z",
  ready: true,
};

Deno.test("memberLiveView: no sightings is never seen", () => {
  assertEquals(memberLiveView([]), { lastSeenAt: null, instances: [] });
});

Deno.test("memberLiveView: the freshest instance comes first and sets lastSeenAt", () => {
  const view = memberLiveView([
    { instanceId: A, at: Date.UTC(2026, 0, 2), runtime: null },
    { instanceId: B, at: Date.UTC(2026, 0, 3), runtime: RUNTIME },
  ]);
  assertEquals(view, {
    lastSeenAt: "2026-01-03T00:00:00.000Z",
    instances: [
      {
        instanceId: B,
        lastSeenAt: "2026-01-03T00:00:00.000Z",
        runtime: RUNTIME,
      },
      { instanceId: A, lastSeenAt: "2026-01-02T00:00:00.000Z", runtime: null },
    ],
  });
});

Deno.test("memberLiveView: equal times order by instance id", () => {
  const at = Date.UTC(2026, 0, 2);
  const view = memberLiveView([
    { instanceId: B, at, runtime: null },
    { instanceId: A, at, runtime: null },
  ]);
  assertEquals(view.instances.map((i) => i.instanceId), [A, B]);
});

Deno.test("memberLiveView: the view does not share the sighting's runtime object", () => {
  const runtime = structuredClone(RUNTIME);
  const view = memberLiveView([{ instanceId: A, at: 0, runtime }]);
  runtime.team.nodes = 9;
  assertEquals(view.instances[0].runtime?.team?.nodes, 2);
});
