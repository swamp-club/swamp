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
import { collect } from "../testing.ts";
import { modelGet, type ModelGetDeps, type ModelGetEvent } from "./get.ts";

function makeDeps(overrides: {
  lookupResult?: { definition: object; type: object } | null;
  modelDef?: object | undefined;
}): ModelGetDeps {
  return {
    lookupDefinition: () =>
      Promise.resolve(
        overrides.lookupResult as Awaited<
          ReturnType<ModelGetDeps["lookupDefinition"]>
        >,
      ),
    getModelDef: () =>
      overrides.modelDef as ReturnType<ModelGetDeps["getModelDef"]>,
  };
}

const testDefinition = {
  id: "def-1",
  name: "my-model",
  version: 3,
  tags: { env: "prod" },
  globalArguments: { region: "us-east-1" },
};

const testModelType = {
  normalized: "aws/s3-bucket",
};

Deno.test("modelGet yields resolving -> completed with model data on success", async () => {
  const deps = makeDeps({
    lookupResult: { definition: testDefinition, type: testModelType },
    modelDef: undefined,
  });

  const events = await collect<ModelGetEvent>(modelGet(deps, "my-model"));

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        id: "def-1",
        name: "my-model",
        type: "aws/s3-bucket",
        version: 3,
        tags: { env: "prod" },
        globalArguments: { region: "us-east-1" },
        typeVersion: undefined,
        globalArgumentsSchema: undefined,
        methods: undefined,
      },
    },
  ]);
});

Deno.test("modelGet yields resolving -> error with not_found when model does not exist", async () => {
  const deps = makeDeps({ lookupResult: null });

  const events = await collect<ModelGetEvent>(
    modelGet(deps, "missing-model"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<ModelGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});
