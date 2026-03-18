// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import type { RepoMarkerData } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  trustList,
  type TrustListDeps,
  type TrustListEvent,
} from "./trust_list.ts";

function makeDeps(overrides?: {
  marker?: RepoMarkerData | null;
  authCollectives?: string[];
}): TrustListDeps {
  return {
    readMarker: () => Promise.resolve(overrides?.marker ?? null),
    loadAuthCollectives: () =>
      Promise.resolve(overrides?.authCollectives ?? undefined),
  };
}

const baseMarker: RepoMarkerData = {
  swampVersion: "1.0.0",
  initializedAt: "2026-01-01T00:00:00Z",
};

Deno.test("trust list shows defaults when no marker exists", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps();

  const events = await collect<TrustListEvent>(trustList(ctx, deps));

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        explicit: ["swamp", "si"],
        membership: [],
        resolved: ["swamp", "si"],
        trustMemberCollectives: true,
      },
    },
  ]);
});

Deno.test("trust list shows explicit collectives from marker", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    marker: { ...baseMarker, trustedCollectives: ["swamp", "si", "myorg"] },
  });

  const events = await collect<TrustListEvent>(trustList(ctx, deps));

  const completed = events[1] as Extract<
    TrustListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.explicit, ["swamp", "si", "myorg"]);
  assertEquals(completed.data.resolved, ["swamp", "si", "myorg"]);
});

Deno.test("trust list merges membership collectives", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    marker: baseMarker,
    authCollectives: ["teamorg"],
  });

  const events = await collect<TrustListEvent>(trustList(ctx, deps));

  const completed = events[1] as Extract<
    TrustListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.explicit, ["swamp", "si"]);
  assertEquals(completed.data.membership, ["teamorg"]);
  assertEquals(completed.data.resolved, ["swamp", "si", "teamorg"]);
  assertEquals(completed.data.trustMemberCollectives, true);
});

Deno.test("trust list excludes membership when trustMemberCollectives is false", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    marker: { ...baseMarker, trustMemberCollectives: false },
    authCollectives: ["teamorg"],
  });

  const events = await collect<TrustListEvent>(trustList(ctx, deps));

  const completed = events[1] as Extract<
    TrustListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.membership, []);
  assertEquals(completed.data.resolved, ["swamp", "si"]);
  assertEquals(completed.data.trustMemberCollectives, false);
});

Deno.test("trust list deduplicates membership collectives that overlap with explicit", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    marker: baseMarker,
    authCollectives: ["swamp", "neworg"],
  });

  const events = await collect<TrustListEvent>(trustList(ctx, deps));

  const completed = events[1] as Extract<
    TrustListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.membership, ["neworg"]);
  assertEquals(completed.data.resolved, ["swamp", "si", "neworg"]);
});
