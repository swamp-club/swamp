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

import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import {
  createLegacyUnitOfWork,
  legacyUnitOfWorkTarget,
} from "./legacy_unit_of_work.ts";
import {
  openRepoUnitOfWork,
  repoUnitOfWorkFactory,
  useUnitOfWorkFactoryForTesting,
} from "./repo_unit_of_work.ts";

function recordingHook(): {
  hook: MarkDirtyHook;
  calls: (string | undefined)[];
} {
  const calls: (string | undefined)[] = [];
  return {
    hook: (relPath?: string) => {
      calls.push(relPath);
      return Promise.resolve();
    },
    calls,
  };
}

Deno.test("repoUnitOfWorkFactory: binds each unit to the repository context's exact hook", () => {
  const { hook } = recordingHook();
  const open = repoUnitOfWorkFactory({ markDirty: hook });
  const first = open();
  const second = open();
  assertNotStrictEquals(first, second);
  assertStrictEquals(legacyUnitOfWorkTarget(first), hook);
  assertStrictEquals(legacyUnitOfWorkTarget(second), hook);
});

Deno.test("repoUnitOfWorkFactory: with no hook the unit is unbound", () => {
  const uow = repoUnitOfWorkFactory({ markDirty: undefined })();
  assertStrictEquals(legacyUnitOfWorkTarget(uow), undefined);
});

Deno.test("openRepoUnitOfWork: forwards a change staged after commit instead of rejecting", async () => {
  const { hook, calls } = recordingHook();
  const uow = openRepoUnitOfWork(hook);
  await uow.commit();
  await uow.stage({ kind: "write", path: "/cache/data/late" });
  assertEquals(calls, ["/cache/data/late"]);
});

Deno.test("useUnitOfWorkFactoryForTesting: receives the bound hook until disposed", () => {
  const { hook } = recordingHook();
  const seen: (MarkDirtyHook | undefined)[] = [];
  const dispose = useUnitOfWorkFactoryForTesting((markDirty) => {
    seen.push(markDirty);
    return createLegacyUnitOfWork(markDirty, { flush: undefined });
  });
  try {
    const uow = repoUnitOfWorkFactory({ markDirty: hook })();
    assertStrictEquals(legacyUnitOfWorkTarget(uow), hook);
  } finally {
    dispose();
  }
  repoUnitOfWorkFactory({ markDirty: hook })();
  assertEquals(seen.length, 1);
  assertStrictEquals(seen[0], hook);
});

Deno.test("useUnitOfWorkFactoryForTesting: refuses a second install while one is active", () => {
  const factory = (markDirty: MarkDirtyHook | undefined) =>
    createLegacyUnitOfWork(markDirty, { flush: undefined });
  const dispose = useUnitOfWorkFactoryForTesting(factory);
  try {
    assertThrows(
      () => useUnitOfWorkFactoryForTesting(factory),
      Error,
      "already installed",
    );
  } finally {
    dispose();
  }
  useUnitOfWorkFactoryForTesting(factory)();
});
