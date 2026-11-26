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
import { FEDERATION_GATE_VARIABLE } from "../../domain/serve/federation_gate.ts";
import {
  buildServeFederationMember,
  memberWorkers,
  type ServeFederationMemberDeps,
} from "./serve_federation_member.ts";

const LIVE = [
  { swampVersion: "1.0.0", labelKeys: ["region", "gpu"] },
  { swampVersion: "1.0.0", labelKeys: ["region"] },
  { swampVersion: "1.1.0", labelKeys: [] },
];

Deno.test("memberWorkers: a serve on its own counts the workers connected to it", () => {
  assertEquals(memberWorkers({ teamMode: "local", liveWorkers: () => LIVE }), {
    workers: {
      total: 3,
      byVersion: { "1.0.0": 2, "1.1.0": 1 },
      byLabelKey: { region: 2, gpu: 1 },
    },
  });
});

Deno.test("memberWorkers: a team counts the shared worker records, so instances never disagree", () => {
  for (const teamMode of ["v3", "v2-shared"] as const) {
    assertEquals(memberWorkers({ teamMode, liveWorkers: () => LIVE }), {});
  }
});

Deno.test("buildServeFederationMember: an error while building is logged and leaves serve without a member", () => {
  const deps = {
    env: (name: string) => name === FEDERATION_GATE_VARIABLE ? "1" : undefined,
    merged: { federation: { hub: "https://hub.example.com" } },
    instanceId: "not-a-uuid",
  } as unknown as ServeFederationMemberDeps;
  assertEquals(buildServeFederationMember(deps), undefined);
});
