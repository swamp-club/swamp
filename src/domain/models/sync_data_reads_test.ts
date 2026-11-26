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

const quiet = () => Promise.resolve({});

function model(
  options: {
    readonly verdict?: boolean;
    readonly added?: boolean;
    readonly check?: boolean;
  } = {},
) {
  return {
    type: TYPE,
    methods: {
      run: { description: "runs", arguments: z.object({}), execute: quiet },
      added: {
        description: "an extension adds it",
        arguments: z.object({}),
        execute: quiet,
        ...(options.added === undefined
          ? {}
          : { readsDataSynchronously: options.added }),
      },
    },
    ...(options.check === undefined ? {} : {
      checks: {
        guard: {
          description: "checks",
          execute: quiet,
          readsDataSynchronously: options.check,
        },
      },
    }),
    ...(options.verdict === undefined
      ? {}
      : { readsDataSynchronously: options.verdict }),
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

Deno.test("mayReadDataSynchronously: the model's bundle decides, and a model with no verdict may", () => {
  assertEquals(
    mayReadDataSynchronously(model({ verdict: true }), "run", false),
    true,
  );
  assertEquals(
    mayReadDataSynchronously(model({ verdict: false }), "run", false),
    false,
  );
  assertEquals(mayReadDataSynchronously(model(), "run", false), true);
  assertEquals(
    mayReadDataSynchronously(model({ verdict: false }), "missing", false),
    true,
  );
  assertEquals(mayReadDataSynchronously(model(), "run", true), false);
});

Deno.test("mayReadDataSynchronously: a method or check an extension adds carries its own bundle's verdict, on a built-in type too", () => {
  for (const builtIn of [true, false]) {
    assertEquals(
      mayReadDataSynchronously(
        model({ verdict: false, added: true }),
        "added",
        builtIn,
      ),
      true,
    );
    assertEquals(
      mayReadDataSynchronously(
        model({ verdict: false, added: true }),
        "run",
        builtIn,
      ),
      false,
    );
    assertEquals(
      mayReadDataSynchronously(
        model({ verdict: false, check: true }),
        "run",
        builtIn,
      ),
      true,
    );
    assertEquals(
      mayReadDataSynchronously(
        model({ verdict: true, added: false }),
        "added",
        builtIn,
      ),
      false,
    );
  }
});
