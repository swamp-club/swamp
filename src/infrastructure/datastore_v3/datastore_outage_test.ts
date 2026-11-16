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
import { CommitUnreachableError } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { V3StorageUnreachableError } from "../../domain/datastore_v3/writer_lease.ts";
import { UserError } from "../../domain/errors.ts";
import {
  causeChainHoldsDatastoreOutage,
  isDatastoreOutage,
  MAX_OUTAGE_CAUSE_DEPTH,
} from "./datastore_outage.ts";
import { ServeUnreachableError } from "./serve_upstream_errors.ts";

Deno.test("isDatastoreOutage: names the storage and serve outages, nothing else", () => {
  assertEquals(
    isDatastoreOutage(
      new ServeUnreachableError("https://serve", "never", new Error("down")),
    ),
    true,
  );
  assertEquals(
    isDatastoreOutage(new V3StorageUnreachableError("/store", new Error("x"))),
    true,
  );
  assertEquals(
    isDatastoreOutage(new CommitUnreachableError(new Error("x"))),
    true,
  );
  assertEquals(isDatastoreOutage(new UserError("no", "forbidden")), false);
  assertEquals(isDatastoreOutage("down"), false);
});

Deno.test("causeChainHoldsDatastoreOutage: finds an outage under wrappers, within the depth limit", () => {
  const outage = new ServeUnreachableError(
    "https://serve",
    "maybe",
    new Error("reset"),
  );
  const wrapAt = (depth: number): Error => {
    let error: Error = outage;
    for (let i = 0; i < depth; i++) {
      const wrapper = new UserError("wrapped", "workflow_execution_failed");
      wrapper.cause = error;
      error = wrapper;
    }
    return error;
  };
  assertEquals(causeChainHoldsDatastoreOutage(wrapAt(0)), true);
  assertEquals(
    causeChainHoldsDatastoreOutage(wrapAt(MAX_OUTAGE_CAUSE_DEPTH - 1)),
    true,
  );
  assertEquals(
    causeChainHoldsDatastoreOutage(wrapAt(MAX_OUTAGE_CAUSE_DEPTH)),
    false,
  );
  const unrelated = new UserError("wrapped", "workflow_execution_failed");
  unrelated.cause = new Error("the method threw");
  assertEquals(causeChainHoldsDatastoreOutage(unrelated), false);
  assertEquals(causeChainHoldsDatastoreOutage(undefined), false);
});
