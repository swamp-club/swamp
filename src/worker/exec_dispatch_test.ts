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

import { assertEquals, assertThrows } from "@std/assert";
import "../domain/models/models.ts";
import {
  type DispatchExecution,
  REMOTE_PROTOCOL_VERSION,
} from "../domain/remote/protocol.ts";
import {
  createStdioReader,
  StdioTransport,
} from "../domain/remote/stdio_transport.ts";
import { definitionFromExecution, runDispatchRunner } from "./exec_dispatch.ts";

Deno.test("runDispatchRunner: returns after sending its result frame instead of exiting", async () => {
  const cacheDirPath = await Deno.makeTempDir({ prefix: "swamp-runner-test-" });
  try {
    // stdin: one bootstrap frame for a dispatch whose model type does not
    // exist, so the runner reports an error result without network access.
    const stdin = new TransformStream<Uint8Array, Uint8Array>();
    const stdinWriter = new StdioTransport(stdin.writable);
    stdinWriter.send(JSON.stringify({
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
    }));

    const written: Uint8Array[] = [];
    const stdout = new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(chunk);
      },
    });

    // Before swamp-club#2467 the runner called Deno.exit(0) here, which
    // would end this test process instead of resolving.
    await runDispatchRunner(stdin.readable, stdout);

    stdinWriter.close();
    await stdin.writable.close();

    const frames: string[] = [];
    await createStdioReader(
      ReadableStream.from(written),
      (frame) => frames.push(frame),
      () => {},
    );
    const result = frames
      .map((f) => JSON.parse(f))
      .find((f) => f.type === "runner.result");
    assertEquals(result?.result.status, "error");
  } finally {
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
