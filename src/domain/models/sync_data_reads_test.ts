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
import { z } from "zod";
import { ModelType } from "./model_type.ts";
import {
  mayReadDataSynchronously,
  namesSyncDataReads,
} from "./sync_data_reads.ts";

const TYPE = ModelType.create("@test/sync-reads");

function model(
  execute: (args: unknown, context: unknown) => Promise<unknown>,
  readsDataSynchronously?: boolean,
) {
  return {
    type: TYPE,
    methods: {
      run: {
        description: "runs",
        arguments: z.object({}),
        execute,
      },
      other: {
        description: "reads synchronously",
        arguments: z.object({}),
        // deno-lint-ignore no-explicit-any
        execute: (_args: unknown, context: any) =>
          Promise.resolve(context.dataRepository.findByNameSync()),
      },
    },
    ...(readsDataSynchronously === undefined ? {} : { readsDataSynchronously }),
  } as unknown as Parameters<typeof mayReadDataSynchronously>[0];
}

Deno.test("namesSyncDataReads: finds each sync data API by name", () => {
  for (
    const name of [
      "getLatestVersionSync",
      "findByNameSync",
      "listVersionsSync",
      "getContentSync",
      "findAllForModelSync",
      "findAllGlobalSync",
      "querySync",
    ]
  ) {
    assertEquals(namesSyncDataReads(`ctx.dataRepository.${name}(a)`), true);
  }
  assertEquals(namesSyncDataReads("ctx.dataRepository.getContent(a)"), false);
});

Deno.test("mayReadDataSynchronously: a bundle's verdict decides; with none, the method's own code; a built-in type is listed", () => {
  const quiet = (_args: unknown, _context: unknown) => Promise.resolve({});
  assertEquals(
    mayReadDataSynchronously(model(quiet, true), "run", false),
    true,
  );
  assertEquals(
    mayReadDataSynchronously(model(quiet, false), "other", false),
    false,
  );
  assertEquals(mayReadDataSynchronously(model(quiet), "run", false), false);
  assertEquals(mayReadDataSynchronously(model(quiet), "other", false), true);
  assertEquals(mayReadDataSynchronously(model(quiet), "missing", false), true);
  assertEquals(mayReadDataSynchronously(model(quiet), "other", true), false);
});
