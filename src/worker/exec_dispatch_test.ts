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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import "../domain/models/models.ts";
import { defineModel, modelRegistry } from "../domain/models/model.ts";
import { ModelType } from "../domain/models/model_type.ts";
import {
  type DispatchExecution,
  type DispatchResult,
  REMOTE_PROTOCOL_VERSION,
} from "../domain/remote/protocol.ts";
import {
  createStdioReader,
  StdioTransport,
} from "../domain/remote/stdio_transport.ts";
import { definitionFromExecution, runDispatchRunner } from "./exec_dispatch.ts";

/**
 * Runs one dispatch through the runner in this process and returns the
 * result frame it wrote, or undefined when it sent none.
 */
async function runRunner(
  bootstrap: Record<string, unknown>,
): Promise<DispatchResult | undefined> {
  const stdin = new TransformStream<Uint8Array, Uint8Array>();
  const stdinWriter = new StdioTransport(stdin.writable);
  stdinWriter.send(JSON.stringify(bootstrap));

  const written: Uint8Array[] = [];
  const stdout = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
  });

  await runDispatchRunner(stdin.readable, stdout);

  stdinWriter.close();
  await stdin.writable.close();

  const frames: string[] = [];
  await createStdioReader(
    ReadableStream.from(written),
    (frame) => frames.push(frame),
    () => {},
  );
  return frames
    .map((f) => JSON.parse(f))
    .find((f) => f.type === "runner.result")?.result as
      | DispatchResult
      | undefined;
}

Deno.test("runDispatchRunner: returns after sending its result frame instead of exiting", async () => {
  const cacheDirPath = await Deno.makeTempDir({ prefix: "swamp-runner-test-" });
  try {
    // stdin: one bootstrap frame for a dispatch whose model type does not
    // exist, so the runner reports an error result without network access.
    // Before swamp-club#2467 the runner called Deno.exit(0) after the result
    // frame, which would end this test process instead of resolving.
    const result = await runRunner({
      sessionCredential: "cred",
      dataPlaneUrl: "http://127.0.0.1:9",
      cacheDirPath,
      dispatch: {
        dispatchId: crypto.randomUUID(),
        leaseId: "l-1",
        execution: {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          modelType: "test/no-such-model",
          modelId: "m-1",
          methodName: "run",
          globalArgs: {},
          methodArgs: {},
          definitionMeta: { id: "def-1", name: "test", version: 1, tags: {} },
        },
        bundleFingerprint: "builtin:test/no-such-model",
        reportBundleFingerprints: [],
        environmentSnapshot: {},
      },
    });
    assertEquals(result?.status, "error");
  } finally {
    await Deno.remove(cacheDirPath, { recursive: true }).catch(() => {});
  }
});

Deno.test("runDispatchRunner: the result error is scrubbed with the dispatch redactor, like the console capture (swamp-club#3525)", async () => {
  // Registered per run: the registry is process-global.
  const type = ModelType.create(`swamp/runner-test-${crypto.randomUUID()}`);
  defineModel({
    type,
    version: "2026.10.20.1",
    methods: {
      fail: {
        description: "logs and throws its secret argument",
        kind: "action",
        arguments: z.object({ secret: z.string() }),
        execute: (args) => {
          const { secret } = args as { secret: string };
          console.log(`console line ${secret}`);
          throw new Error(`method failed holding ${secret}`);
        },
      },
    },
  });
  const cacheDirPath = await Deno.makeTempDir({ prefix: "swamp-runner-test-" });
  try {
    const secret = `canary-${crypto.randomUUID()}`;
    const result = await runRunner({
      sessionCredential: "cred",
      dataPlaneUrl: "http://127.0.0.1:9",
      cacheDirPath,
      dispatch: {
        dispatchId: crypto.randomUUID(),
        leaseId: crypto.randomUUID(),
        execution: {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          modelType: type.normalized,
          modelId: crypto.randomUUID(),
          methodName: "fail",
          globalArgs: {},
          methodArgs: { secret },
          definitionMeta: {
            id: crypto.randomUUID(),
            name: "runner-test",
            version: 1,
            tags: {},
          },
        },
        bundleFingerprint: `builtin:${type.normalized}`,
        reportBundleFingerprints: [],
        environmentSnapshot: {},
        secretValues: [secret],
      },
    });
    assertEquals(result?.status, "error");
    assertEquals(result?.error, "method failed holding ***");
    assert(result?.logs.includes("console line ***"));
    assertEquals(result?.logs.filter((line) => line.includes(secret)), []);
  } finally {
    modelRegistry.invalidateType(type);
    await Deno.remove(cacheDirPath, { recursive: true }).catch(() => {});
  }
});

function executionNamed(name: string): DispatchExecution {
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    modelType: "command/shell",
    modelId: "m-1",
    methodName: "execute",
    globalArgs: { region: "us-east-1" },
    methodArgs: {},
    definitionMeta: {
      id: crypto.randomUUID(),
      name,
      version: 3,
      tags: { env: "test" },
    },
  };
}

Deno.test("definitionFromExecution: accepts a name that predates the strict naming rule", () => {
  // A definition named before bf0320ef loads and runs locally; the worker
  // rejected it with a ZodError until swamp-club#2926.
  const execution = executionNamed("MyServer");
  const definition = definitionFromExecution(execution, { run: "echo hi" });

  assertEquals(definition.name, "MyServer");
  assertEquals(definition.id, execution.definitionMeta.id);
  assertEquals(definition.type, "command/shell");
  assertEquals(definition.version, 3);
  assertEquals(definition.tags, { env: "test" });
  assertEquals(definition.globalArguments, { region: "us-east-1" });
  assertEquals(definition.getMethodArguments("execute"), { run: "echo hi" });
  assertEquals(definition.typeVersion, undefined);
});

Deno.test("definitionFromExecution: accepts a name longer than the new-definition limit", () => {
  const name = "a".repeat(65);
  assertEquals(definitionFromExecution(executionNamed(name), {}).name, name);
});

Deno.test("definitionFromExecution: still rejects a path-traversal name", () => {
  assertThrows(
    () => definitionFromExecution(executionNamed("../etc"), {}),
    Error,
    "path traversal",
  );
});
