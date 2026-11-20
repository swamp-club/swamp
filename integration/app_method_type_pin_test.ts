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
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";
import {
  createServeCtx,
  errorFrame,
  saveModel,
  sendRequest,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

Deno.test("model.method.run: a behavior of another type than expectedType is refused before it runs", async () => {
  await withServeRepo(async (repo) => {
    await saveModel(repo, "deploy");
    const frames = await sendRequest(createServeCtx(repo), {
      type: "model.method.run",
      id: crypto.randomUUID(),
      payload: {
        modelIdOrName: "deploy",
        methodName: "noop",
        expectedType: "@acme/harmless",
      },
    });
    const error = errorFrame(frames) as
      | { error: { code: string } }
      | undefined;
    assertEquals(error?.error.code, "method_type_mismatch");
    assertEquals(frames.some((frame) => frame.type === "event"), false);
  });
});

Deno.test("model.method.run: a behavior of the expected type runs", async () => {
  await withServeRepo(async (repo) => {
    await saveModel(repo, "deploy");
    const frames = await sendRequest(createServeCtx(repo), {
      type: "model.method.run",
      id: crypto.randomUUID(),
      payload: {
        modelIdOrName: "deploy",
        methodName: "noop",
        expectedType: repo.modelType.normalized,
      },
    });
    assertEquals(errorFrame(frames), undefined);
  });
});

Deno.test("model.method.run: a direct run naming another type than expectedType is refused", async () => {
  await withServeRepo(async (repo) => {
    const frames = await sendRequest(createServeCtx(repo), {
      type: "model.method.run",
      id: crypto.randomUUID(),
      payload: {
        modelIdOrName: "fresh",
        methodName: "noop",
        typeArg: repo.modelType.normalized,
        definitionName: "fresh",
        expectedType: "@acme/harmless",
      },
    });
    const error = errorFrame(frames) as
      | { error: { code: string } }
      | undefined;
    assertEquals(error?.error.code, "method_type_mismatch");
  });
});

Deno.test("model.method.run: an expectedType with no behavior to check is refused", async () => {
  await withServeRepo(async (repo) => {
    const frames = await sendRequest(createServeCtx(repo), {
      type: "model.method.run",
      id: crypto.randomUUID(),
      payload: {
        modelIdOrName: "missing",
        methodName: "noop",
        expectedType: repo.modelType.normalized,
      },
    });
    const error = errorFrame(frames) as
      | { error: { code: string } }
      | undefined;
    assertEquals(error?.error.code, "method_type_mismatch");
  });
});
