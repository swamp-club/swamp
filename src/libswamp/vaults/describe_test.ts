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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import type { VaultConfigInfo } from "./get.ts";
import {
  vaultDescribe,
  type VaultDescribeDeps,
  type VaultDescribeEvent,
} from "./describe.ts";

const testCreatedAt = new Date("2026-01-01T00:00:00.000Z");

const testVault: VaultConfigInfo = {
  id: "vault-1",
  name: "my-vault",
  type: "file",
  config: { path: "/vaults/my-vault" },
  createdAt: testCreatedAt,
};

function makeDeps(overrides: {
  byName?: VaultConfigInfo | null;
  byId?: VaultConfigInfo | null;
  all?: VaultConfigInfo[];
}): VaultDescribeDeps {
  return {
    findByName: () => Promise.resolve(overrides.byName ?? null),
    findById: () => Promise.resolve(overrides.byId ?? null),
    findAll: () => Promise.resolve(overrides.all ?? []),
  };
}

Deno.test("vaultDescribe yields resolving -> completed when found by name", async () => {
  const deps = makeDeps({ byName: testVault });

  const events = await collect<VaultDescribeEvent>(
    vaultDescribe(createLibSwampContext(), deps, "my-vault"),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        id: "vault-1",
        name: "my-vault",
        type: "file",
        config: { path: "/vaults/my-vault" },
        createdAt: testCreatedAt.toISOString(),
      },
    },
  ]);
});

Deno.test("vaultDescribe yields resolving -> error with not_found when vault does not exist", async () => {
  const deps = makeDeps({ byName: null, all: [] });

  const events = await collect<VaultDescribeEvent>(
    vaultDescribe(createLibSwampContext(), deps, "missing-vault"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<VaultDescribeEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});
