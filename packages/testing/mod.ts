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

/**
 * @systeminit/swamp-testing — Test utilities for swamp extension models.
 *
 * Provides a fake {@linkcode MethodContext} for unit testing extension model
 * `execute` functions without running against real infrastructure.
 *
 * ```typescript
 * import { createModelTestContext } from "@systeminit/swamp-testing";
 * import { assertEquals } from "@std/assert";
 * import { model } from "./my_model.ts";
 *
 * Deno.test("run method writes expected resource", async () => {
 *   const { context, getWrittenResources } = createModelTestContext({
 *     globalArgs: { message: "hello" },
 *   });
 *
 *   await model.methods.run.execute({}, context);
 *
 *   const resources = getWrittenResources();
 *   assertEquals(resources.length, 1);
 *   assertEquals(resources[0].data.message, "HELLO");
 * });
 * ```
 *
 * @module
 */

export { createModelTestContext } from "./test_context.ts";

export type {
  CapturedLog,
  ModelTestContextOptions,
  ModelTestContextResult,
  WrittenFile,
  WrittenResource,
} from "./test_context.ts";

export type {
  DataHandle,
  DataHandleMetadata,
  DataWriter,
  DefinitionInfo,
  GarbageCollectionPolicy,
  Lifetime,
  LogLevel,
  MethodContext,
  MethodExecutionEvent,
  MethodResult,
  OwnerDefinition,
} from "./types.ts";
