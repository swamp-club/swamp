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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { modelGet, type ModelGetDeps, type ModelGetEvent } from "./get.ts";

function completedData(events: ModelGetEvent[]) {
  const completed = events.find((e) => e.kind === "completed");
  if (!completed || completed.kind !== "completed") {
    throw new Error("expected a completed event");
  }
  return completed.data;
}

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

  const events = await collect<ModelGetEvent>(
    modelGet(createLibSwampContext(), deps, "my-model"),
  );

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

Deno.test("modelGet redacts sensitive global arguments when the schema is known", async () => {
  const deps = makeDeps({
    lookupResult: {
      definition: {
        id: "def-2",
        name: "secret-model",
        version: 1,
        tags: {},
        globalArguments: { apiKey: "SUPERSECRET123", region: "us-east-1" },
      },
      type: { normalized: "acme/widget" },
    },
    modelDef: {
      version: "2026.05.28.1",
      globalArguments: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        region: z.string(),
      }),
      methods: {},
    },
  });

  const events = await collect<ModelGetEvent>(
    modelGet(createLibSwampContext(), deps, "secret-model"),
  );

  assertEquals(completedData(events).globalArguments, {
    apiKey: "***",
    region: "us-east-1",
  });
});

Deno.test("modelGet passes global arguments through unredacted when the model type is unavailable", async () => {
  const deps = makeDeps({
    lookupResult: {
      definition: {
        id: "def-3",
        name: "uninstalled-model",
        version: 1,
        tags: {},
        globalArguments: { apiKey: "SUPERSECRET123" },
      },
      type: { normalized: "acme/widget" },
    },
    modelDef: undefined,
  });

  const events = await collect<ModelGetEvent>(
    modelGet(createLibSwampContext(), deps, "uninstalled-model"),
  );

  assertEquals(completedData(events).globalArguments, {
    apiKey: "SUPERSECRET123",
  });
});

Deno.test("modelGet yields resolving -> error with not_found when model does not exist", async () => {
  const deps = makeDeps({ lookupResult: null });

  const events = await collect<ModelGetEvent>(
    modelGet(createLibSwampContext(), deps, "missing-model"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<ModelGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});
