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
  trustAutoTrust,
  type TrustAutoTrustDeps,
  type TrustAutoTrustEvent,
} from "./trust_auto_trust.ts";

const baseMarker: RepoMarkerData = {
  swampVersion: "1.0.0",
  initializedAt: "2026-01-01T00:00:00Z",
};

Deno.test("trust auto-trust enables membership trust", async () => {
  const ctx = createLibSwampContext();
  let writtenMarker: RepoMarkerData | undefined;
  const deps: TrustAutoTrustDeps = {
    readMarker: () =>
      Promise.resolve({ ...baseMarker, trustMemberCollectives: false }),
    writeMarker: (data) => {
      writtenMarker = data;
      return Promise.resolve();
    },
  };

  const events = await collect<TrustAutoTrustEvent>(
    trustAutoTrust(ctx, deps, true),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "completed",
      data: { trustMemberCollectives: true },
    },
  ]);
  assertEquals(writtenMarker?.trustMemberCollectives, true);
});

Deno.test("trust auto-trust disables membership trust", async () => {
  const ctx = createLibSwampContext();
  let writtenMarker: RepoMarkerData | undefined;
  const deps: TrustAutoTrustDeps = {
    readMarker: () => Promise.resolve({ ...baseMarker }),
    writeMarker: (data) => {
      writtenMarker = data;
      return Promise.resolve();
    },
  };

  const events = await collect<TrustAutoTrustEvent>(
    trustAutoTrust(ctx, deps, false),
  );

  const completed = events[1] as Extract<
    TrustAutoTrustEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.trustMemberCollectives, false);
  assertEquals(writtenMarker?.trustMemberCollectives, false);
});

Deno.test("trust auto-trust errors when not in a swamp repo", async () => {
  const ctx = createLibSwampContext();
  const deps: TrustAutoTrustDeps = {
    readMarker: () => Promise.resolve(null),
    writeMarker: () => Promise.resolve(),
  };

  const events = await collect<TrustAutoTrustEvent>(
    trustAutoTrust(ctx, deps, true),
  );

  assertEquals(events.length, 2);
  const last = events[1] as Extract<
    TrustAutoTrustEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});
