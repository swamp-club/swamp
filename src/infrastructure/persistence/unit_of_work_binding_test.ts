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

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { UnitOfWork } from "../../domain/datastore/unit_of_work.ts";
import {
  createLegacyUnitOfWork,
  legacyUnitOfWorkTarget,
} from "./legacy_unit_of_work.ts";
import { unitOfWorkBinding } from "./unit_of_work_binding.ts";

function hook(): MarkDirtyHook {
  return () => Promise.resolve();
}

/** A unit of work no adapter built. */
function bareUnit(): UnitOfWork {
  return {
    stage: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    abandon: () => Promise.resolve(),
    staged: () => [],
  };
}

Deno.test("unitOfWorkBinding: a bound unit reports the exact hook it was bound to", () => {
  const markDirty = hook();
  const uow = bareUnit();
  unitOfWorkBinding.bind(uow, markDirty);
  assertStrictEquals(unitOfWorkBinding.boundHook(uow), markDirty);
});

Deno.test("unitOfWorkBinding: an unbound unit has no hook", () => {
  assertStrictEquals(unitOfWorkBinding.boundHook(bareUnit()), undefined);
});

Deno.test("unitOfWorkBinding: a wrapper of a hook is a different hook", () => {
  const markDirty = hook();
  const wrapped: MarkDirtyHook = (path) => markDirty(path);
  const uow = bareUnit();
  unitOfWorkBinding.bind(uow, wrapped);
  assertEquals(unitOfWorkBinding.boundHook(uow) === markDirty, false);
});

Deno.test("unitOfWorkBinding: binding again to the same hook is allowed, to another hook throws", () => {
  const markDirty = hook();
  const uow = bareUnit();
  unitOfWorkBinding.bind(uow, markDirty);
  unitOfWorkBinding.bind(uow, markDirty);
  assertThrows(
    () => unitOfWorkBinding.bind(uow, hook()),
    Error,
    "already bound to another repository context",
  );
  assertStrictEquals(unitOfWorkBinding.boundHook(uow), markDirty);
});

Deno.test("unitOfWorkBinding: nested roots over two hooks each keep their own hook", () => {
  const outerHook = hook();
  const innerHook = hook();
  const outer = createLegacyUnitOfWork(outerHook, { flush: undefined });
  const inner = createLegacyUnitOfWork(innerHook, {
    flush: undefined,
    parent: outer,
  });
  assertStrictEquals(unitOfWorkBinding.boundHook(outer), outerHook);
  assertStrictEquals(unitOfWorkBinding.boundHook(inner), innerHook);
});

Deno.test("unitOfWorkBinding: the legacy adapter binds units built with a hook, not those built without", () => {
  const markDirty = hook();
  const bound = createLegacyUnitOfWork(markDirty, { flush: undefined });
  const unbound = createLegacyUnitOfWork(undefined, { flush: undefined });
  assertStrictEquals(unitOfWorkBinding.boundHook(bound), markDirty);
  assertStrictEquals(unitOfWorkBinding.boundHook(unbound), undefined);
});

Deno.test("legacyUnitOfWorkTarget: ignores a unit another adapter bound", () => {
  const uow = bareUnit();
  unitOfWorkBinding.bind(uow, hook());
  assertStrictEquals(legacyUnitOfWorkTarget(uow), undefined);
});

Deno.test("unitOfWorkBinding: requireUnit marks exactly the hook given", () => {
  const markDirty = hook();
  const other = hook();
  assertEquals(unitOfWorkBinding.requiresUnit(markDirty), false);
  unitOfWorkBinding.requireUnit(markDirty);
  assertEquals(unitOfWorkBinding.requiresUnit(markDirty), true);
  assertEquals(unitOfWorkBinding.requiresUnit(other), false);
  assertEquals(
    unitOfWorkBinding.requiresUnit((path) => markDirty(path)),
    false,
  );
});
