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
import { trustRm, type TrustRmDeps } from "./trust_rm.ts";
import type { TrustModifyEvent } from "./trust.ts";

function makeDeps(overrides?: {
  marker?: RepoMarkerData | null;
}): TrustRmDeps {
  return {
    readMarker: () => Promise.resolve(overrides?.marker ?? null),
    writeMarker: () => Promise.resolve(),
  };
}

const baseMarker: RepoMarkerData = {
  swampVersion: "1.0.0",
  initializedAt: "2026-01-01T00:00:00Z",
};

Deno.test("trust rm removes a collective from the list", async () => {
  const ctx = createLibSwampContext();
  let writtenMarker: RepoMarkerData | undefined;
  const deps: TrustRmDeps = {
    readMarker: () =>
      Promise.resolve({
        ...baseMarker,
        trustedCollectives: ["swamp", "si", "myorg"],
      }),
    writeMarker: (data) => {
      writtenMarker = data;
      return Promise.resolve();
    },
  };

  const events = await collect<TrustModifyEvent>(trustRm(ctx, deps, "myorg"));

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        action: "removed",
        collective: "myorg",
        trustedCollectives: ["swamp", "si"],
      },
    },
  ]);
  assertEquals(writtenMarker?.trustedCollectives, ["swamp", "si"]);
});

Deno.test("trust rm allows removing default collectives", async () => {
  const ctx = createLibSwampContext();
  let writtenMarker: RepoMarkerData | undefined;
  const deps: TrustRmDeps = {
    readMarker: () =>
      Promise.resolve({
        ...baseMarker,
        trustedCollectives: ["swamp", "si"],
      }),
    writeMarker: (data) => {
      writtenMarker = data;
      return Promise.resolve();
    },
  };

  const events = await collect<TrustModifyEvent>(trustRm(ctx, deps, "swamp"));

  const completed = events[1] as Extract<
    TrustModifyEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.trustedCollectives, ["si"]);
  assertEquals(writtenMarker?.trustedCollectives, ["si"]);
});

Deno.test("trust rm writes empty array when last collective removed", async () => {
  const ctx = createLibSwampContext();
  let writtenMarker: RepoMarkerData | undefined;
  const deps: TrustRmDeps = {
    readMarker: () =>
      Promise.resolve({
        ...baseMarker,
        trustedCollectives: ["only"],
      }),
    writeMarker: (data) => {
      writtenMarker = data;
      return Promise.resolve();
    },
  };

  const events = await collect<TrustModifyEvent>(trustRm(ctx, deps, "only"));

  const completed = events[1] as Extract<
    TrustModifyEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.trustedCollectives, []);
  assertEquals(writtenMarker?.trustedCollectives, []);
});

Deno.test("trust rm errors when collective not in list", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    marker: { ...baseMarker, trustedCollectives: ["swamp", "si"] },
  });

  const events = await collect<TrustModifyEvent>(
    trustRm(ctx, deps, "nonexistent"),
  );

  assertEquals(events.length, 2);
  const last = events[1] as Extract<TrustModifyEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("trust rm errors when not in a swamp repo", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ marker: null });

  const events = await collect<TrustModifyEvent>(trustRm(ctx, deps, "myorg"));

  assertEquals(events.length, 2);
  const last = events[1] as Extract<TrustModifyEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});
