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
  assertInstanceOf,
  AssertionError,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type {
  StagedChange,
  UnitOfWork,
} from "../../domain/datastore/unit_of_work.ts";
import { assertUnitOfWorkContract } from "./unit_of_work_contract.ts";

Deno.test("assertUnitOfWorkContract: names the failing case and keeps the original error as the cause", async () => {
  // Forwards a path only the first time it is staged, which the contract
  // forbids.
  const deduplicating = () => {
    const changes: StagedChange[] = [];
    const forwarded: (string | undefined)[] = [];
    const unit: UnitOfWork = {
      stage(change) {
        const target = change.kind === "bulk" ? undefined : change.path;
        if (target === undefined || !forwarded.includes(target)) {
          forwarded.push(target);
        }
        changes.push(change);
        return Promise.resolve();
      },
      commit: () => Promise.resolve(),
      staged: () => [...changes],
    };
    return {
      unit,
      forwarded: () => forwarded,
      failNext: () => {},
      holdNext: () => () => {},
      pendingForwards: () => 0,
      onCommit: () => {},
    };
  };

  const error = await assertRejects(
    () => assertUnitOfWorkContract(deduplicating),
    AssertionError,
  );

  assertStringIncludes(error.message, '"stage order is preserved"');
  assertInstanceOf(error.cause, AssertionError);
});
