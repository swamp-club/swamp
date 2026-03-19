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
import { trustAdd, type TrustAddDeps } from "./trust_add.ts";
import type { TrustModifyEvent } from "./trust.ts";

function makeDeps(overrides?: {
  marker?: RepoMarkerData | null;
}): TrustAddDeps {
  return {
    readMarker: () => Promise.resolve(overrides?.marker ?? null),
    writeMarker: () => Promise.resolve(),
  };
}

const baseMarker: RepoMarkerData = {
  swampVersion: "1.0.0",
  initializedAt: "2026-01-01T00:00:00Z",
};

Deno.test("trust add adds a collective to the list", async () => {
  const ctx = createLibSwampContext();
  let writtenMarker: RepoMarkerData | undefined;
  const deps: TrustAddDeps = {
    readMarker: () => Promise.resolve({ ...baseMarker }),
    writeMarker: (data) => {
      writtenMarker = data;
      return Promise.resolve();
    },
  };

  const events = await collect<TrustModifyEvent>(trustAdd(ctx, deps, "myorg"));

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        action: "added",
        collective: "myorg",
        trustedCollectives: ["swamp", "si", "myorg"],
      },
    },
  ]);
  assertEquals(writtenMarker?.trustedCollectives, ["swamp", "si", "myorg"]);
});

Deno.test("trust add errors on invalid collective name", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ marker: baseMarker });

  const events = await collect<TrustModifyEvent>(
    trustAdd(ctx, deps, "INVALID!"),
  );

  assertEquals(events.length, 2);
  const last = events[1] as Extract<TrustModifyEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("trust add errors when collective already exists", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({
    marker: { ...baseMarker, trustedCollectives: ["swamp", "si"] },
  });

  const events = await collect<TrustModifyEvent>(trustAdd(ctx, deps, "swamp"));

  assertEquals(events.length, 2);
  const last = events[1] as Extract<TrustModifyEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "already_exists");
});

Deno.test("trust add errors when not in a swamp repo", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps({ marker: null });

  const events = await collect<TrustModifyEvent>(trustAdd(ctx, deps, "myorg"));

  assertEquals(events.length, 2);
  const last = events[1] as Extract<TrustModifyEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("trust add initializes from defaults when trustedCollectives is undefined", async () => {
  const ctx = createLibSwampContext();
  let writtenMarker: RepoMarkerData | undefined;
  const deps: TrustAddDeps = {
    readMarker: () => Promise.resolve({ ...baseMarker }),
    writeMarker: (data) => {
      writtenMarker = data;
      return Promise.resolve();
    },
  };

  const events = await collect<TrustModifyEvent>(trustAdd(ctx, deps, "neworg"));

  const completed = events[1] as Extract<
    TrustModifyEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.trustedCollectives, ["swamp", "si", "neworg"]);
  assertEquals(writtenMarker?.trustedCollectives, ["swamp", "si", "neworg"]);
});
