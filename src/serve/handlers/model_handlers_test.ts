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
import { isMethodMutating } from "./model_handlers.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";

const TEST_TYPE = ModelType.create("test/lock-check");

function registerTestModel(methods: Record<string, { kind?: string }>) {
  const methodDefs: Record<
    string,
    {
      description: string;
      kind?: "read" | "list" | "create" | "update" | "delete" | "action";
      arguments: z.ZodTypeAny;
      execute: () => Promise<Record<string, unknown>>;
    }
  > = {};
  for (const [name, config] of Object.entries(methods)) {
    methodDefs[name] = {
      description: `test method ${name}`,
      ...(config.kind
        ? {
          kind: config.kind as
            | "read"
            | "list"
            | "create"
            | "update"
            | "delete"
            | "action",
        }
        : {}),
      arguments: z.object({}),
      execute: () => Promise.resolve({}),
    };
  }
  modelRegistry.register({
    type: TEST_TYPE,
    version: "2026.01.01.1",
    methods: methodDefs,
  });
}

function cleanup() {
  modelRegistry.invalidateType(TEST_TYPE);
}

Deno.test("isMethodMutating: returns false for method with kind 'read'", async () => {
  registerTestModel({ status: { kind: "read" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "status"), false);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns false for method with kind 'list'", async () => {
  registerTestModel({ search: { kind: "list" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "search"), false);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with kind 'create'", async () => {
  registerTestModel({ provision: { kind: "create" } });
  try {
    assertEquals(
      await isMethodMutating(TEST_TYPE.normalized, "provision"),
      true,
    );
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with kind 'update'", async () => {
  registerTestModel({ patch: { kind: "update" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "patch"), true);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with kind 'action'", async () => {
  registerTestModel({ deploy: { kind: "action" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "deploy"), true);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with no kind and unrecognized name", async () => {
  registerTestModel({ custom_process: {} });
  try {
    assertEquals(
      await isMethodMutating(TEST_TYPE.normalized, "custom_process"),
      true,
    );
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: infers 'read' from name 'get' without explicit kind", async () => {
  registerTestModel({ get: {} });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "get"), false);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: infers 'list' from name 'list' without explicit kind", async () => {
  registerTestModel({ list: {} });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "list"), false);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for method with kind 'delete'", async () => {
  registerTestModel({ purge: { kind: "delete" } });
  try {
    assertEquals(await isMethodMutating(TEST_TYPE.normalized, "purge"), true);
  } finally {
    cleanup();
  }
});

Deno.test("isMethodMutating: returns true for unknown model type", async () => {
  assertEquals(
    await isMethodMutating("nonexistent/model-type", "get"),
    true,
  );
});

Deno.test("isMethodMutating: returns true for unknown method on known model", async () => {
  registerTestModel({ run: { kind: "action" } });
  try {
    assertEquals(
      await isMethodMutating(TEST_TYPE.normalized, "nonexistent"),
      true,
    );
  } finally {
    cleanup();
  }
});
