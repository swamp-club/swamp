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

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { z } from "zod";
import { UserError } from "../domain/errors.ts";
import "../domain/models/models.ts";
import { defineModel, modelRegistry } from "../domain/models/model.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { runFileSink } from "../infrastructure/logging/run_file_sink.ts";
import {
  DISPATCH_SECRETS_PATH,
  type DispatchExecution,
  type DispatchResult,
  LEGACY_PLAINTEXT_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
} from "../domain/remote/protocol.ts";
import { SecretBagRegistry } from "../domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../domain/vaults/vault_secret_bag.ts";
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
          // Its secrets travel in the frame, as a version 5 dispatch's do.
          protocolVersion: LEGACY_PLAINTEXT_PROTOCOL_VERSION,
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

/**
 * A version 5 bootstrap for `modelType`'s `run` method, shipping `secret` in
 * the frame.
 */
function bootstrapFor(cacheDirPath: string, modelType: string, secret: string) {
  const definitionId = crypto.randomUUID();
  return {
    sessionCredential: "cred",
    dataPlaneUrl: "http://127.0.0.1:9",
    cacheDirPath,
    dispatch: {
      dispatchId: crypto.randomUUID(),
      leaseId: crypto.randomUUID(),
      execution: {
        protocolVersion: LEGACY_PLAINTEXT_PROTOCOL_VERSION,
        modelType,
        modelId: definitionId,
        methodName: "run",
        globalArgs: {},
        methodArgs: {},
        definitionMeta: {
          id: definitionId,
          name: "test",
          version: 1,
          tags: {},
        },
      },
      bundleFingerprint: `builtin:${modelType}`,
      reportBundleFingerprints: [],
      environmentSnapshot: {},
      secretValues: [secret],
    },
  };
}

Deno.test("runDispatchRunner: the dispatch redactor is active while the method runs and released once the dispatch is over (swamp-club#3526)", async () => {
  // A per-run type name: the registry is process-global and --repeats must
  // register again.
  const type = ModelType.create(`swamp/runner-redactor-${crypto.randomUUID()}`);
  const secret = "secret-3526-active";
  let observed: string | undefined;
  defineModel({
    type,
    version: "2026.10.20.1",
    methods: {
      run: {
        description: "records what the process redactors mask while it runs",
        kind: "action",
        arguments: z.object({}),
        execute: () => {
          observed = runFileSink.redactActive(`saw ${secret}`);
          return Promise.resolve({});
        },
      },
    },
  });
  const cacheDirPath = await Deno.makeTempDir({ prefix: "swamp-runner-test-" });
  try {
    const result = await runRunner(
      bootstrapFor(cacheDirPath, type.normalized, secret),
    );

    assertEquals(result?.status, "success", result?.error);
    assertEquals(observed, "saw ***");
    assertEquals(runFileSink.redactActive(secret), secret);
  } finally {
    modelRegistry.invalidateType(type);
    await Deno.remove(cacheDirPath, { recursive: true }).catch(() => {});
  }
});

Deno.test("runDispatchRunner: releases the dispatch redactor when the dispatch fails", async () => {
  const secret = "secret-3526-failed";
  const cacheDirPath = await Deno.makeTempDir({ prefix: "swamp-runner-test-" });
  try {
    const result = await runRunner(
      bootstrapFor(cacheDirPath, "test/no-such-model", secret),
    );

    assertEquals(result?.status, "error");
    assertEquals(runFileSink.redactActive(secret), secret);
  } finally {
    await Deno.remove(cacheDirPath, { recursive: true }).catch(() => {});
  }
});

Deno.test("runDispatchRunner: leaves the scratch dir the supervisor made for the supervisor to remove (swamp-club#3854)", async () => {
  const cacheDirPath = await Deno.makeTempDir({ prefix: "swamp-runner-test-" });
  const scratchDirPath = await Deno.makeTempDir({
    prefix: "swamp-runner-scratch-test-",
  });
  try {
    const result = await runRunner({
      ...bootstrapFor(cacheDirPath, "test/no-such-model", "secret-3854"),
      scratchDirPath,
    });
    assertEquals(result?.status, "error");
    assertEquals((await Deno.stat(scratchDirPath)).isDirectory, true);
  } finally {
    await Deno.remove(scratchDirPath, { recursive: true });
    await Deno.remove(cacheDirPath, { recursive: true }).catch(() => {});
  }
});

/** Registers a per-run model type whose `run` method throws `thrown`. */
function throwingRunModel(thrown: Error): ModelType {
  const type = ModelType.create(`swamp/runner-test-${crypto.randomUUID()}`);
  defineModel({
    type,
    version: "2026.10.22.1",
    methods: {
      run: {
        description: "throws the given error",
        kind: "action",
        arguments: z.object({}),
        execute: () => {
          throw thrown;
        },
      },
    },
  });
  return type;
}

Deno.test("runDispatchRunner: the result carries the code of a coded UserError the method threw (swamp-club#3773)", async () => {
  const type = throwingRunModel(
    new UserError("intentional failure", "auth_failed"),
  );
  const cacheDirPath = await Deno.makeTempDir({ prefix: "swamp-runner-test-" });
  try {
    const result = await runRunner(
      bootstrapFor(cacheDirPath, type.normalized, "secret-3773-unrelated"),
    );

    assertEquals(result?.status, "error");
    assertEquals(result?.error, "intentional failure");
    assertEquals(result?.errorCode, "auth_failed");
  } finally {
    modelRegistry.invalidateType(type);
    await Deno.remove(cacheDirPath, { recursive: true }).catch(() => {});
  }
});

Deno.test("runDispatchRunner: the result error code is scrubbed with the dispatch redactor", async () => {
  const secret = `canary-${crypto.randomUUID()}`;
  const type = throwingRunModel(
    new UserError("intentional failure", `failed_${secret}`),
  );
  const cacheDirPath = await Deno.makeTempDir({ prefix: "swamp-runner-test-" });
  try {
    const result = await runRunner(
      bootstrapFor(cacheDirPath, type.normalized, secret),
    );

    assertEquals(result?.status, "error");
    assertEquals(result?.errorCode, "failed_***");
  } finally {
    modelRegistry.invalidateType(type);
    await Deno.remove(cacheDirPath, { recursive: true }).catch(() => {});
  }
});

Deno.test("runDispatchRunner: the result carries no code for an uncoded error", async () => {
  const type = throwingRunModel(new UserError("intentional failure"));
  const cacheDirPath = await Deno.makeTempDir({ prefix: "swamp-runner-test-" });
  try {
    const result = await runRunner(
      bootstrapFor(cacheDirPath, type.normalized, "secret-3773-unrelated"),
    );

    assertEquals(result?.status, "error");
    assertEquals(result?.errorCode, undefined);
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

/**
 * Runs one dispatch through the runner in this process, answering every call
 * the runner makes of its supervisor as the supervisor does, and returns
 * the result frame with the calls it made.
 */
async function runRunnerAnswering(
  bootstrap: Record<string, unknown>,
): Promise<{ result: DispatchResult | undefined; calls: string[] }> {
  const stdin = new TransformStream<Uint8Array, Uint8Array>();
  const stdinWriter = new StdioTransport(stdin.writable);
  stdinWriter.send(JSON.stringify(bootstrap));
  const calls: string[] = [];
  let result: DispatchResult | undefined;
  let pending = new Uint8Array(0);
  const stdout = new WritableStream<Uint8Array>({
    write(chunk) {
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending);
      joined.set(chunk, pending.length);
      pending = joined;
      // Length-prefixed frames, as the stdio transport writes them.
      while (pending.length >= 4) {
        const length = new DataView(pending.buffer, pending.byteOffset)
          .getUint32(0);
        if (pending.length < 4 + length) break;
        const frame = JSON.parse(
          new TextDecoder().decode(pending.subarray(4, 4 + length)),
        );
        pending = pending.slice(4 + length);
        if (frame.type === "runner.result") {
          result = frame.result as DispatchResult;
        } else if (frame.type === "rpc.request") {
          calls.push(frame.method);
          stdinWriter.send(
            JSON.stringify({ type: "rpc.response", id: frame.id, result: {} }),
          );
        }
      }
    },
  });
  await runDispatchRunner(stdin.readable, stdout);
  stdinWriter.close();
  await stdin.writable.close();
  return { result, calls };
}

Deno.test("runDispatchRunner: a version 6 dispatch loads its references once through the route, validates its arguments on the worker, reports it, and masks what it loaded (typed-secrets 5.2)", async () => {
  const type = ModelType.create(`swamp/runner-v6-${crypto.randomUUID()}`);
  const token = `canary-${crypto.randomUUID()}`;
  const received: Record<string, unknown>[] = [];
  defineModel({
    type,
    version: "2026.10.28.1",
    globalArguments: z.object({ endpoint: z.string().url() }),
    methods: {
      run: {
        description: "records and prints what it receives",
        kind: "action",
        arguments: z.object({ token: z.string() }),
        execute: (args, context) => {
          const { token } = args as { token: string };
          received.push({ token, endpoint: context.globalArgs.endpoint });
          console.log(`token ${token}`);
          return Promise.resolve({});
        },
      },
    },
  });
  // Serve's bag, which ships its references and no value.
  const serveBag = new VaultSecretBag(new SecretBagRegistry());
  const endpoint = serveBag.addSecret(
    { vaultName: "v", key: "endpoint" },
    "globalArguments.endpoint",
  );
  const tokenSentinel = serveBag.addSecret(
    { vaultName: "v", key: "token" },
    "methods.run.arguments.token",
  );
  const globalArgs = { endpoint };
  const methodArgs = { token: tokenSentinel };
  const definitionId = crypto.randomUUID();
  const cacheDirPath = await Deno.makeTempDir({ prefix: "swamp-runner-test-" });
  try {
    const { result: run, calls } = await withMockedFetch(
      [Response.json({
        values: [
          { vaultName: "v", key: "endpoint", value: "https://api.example.com" },
          { vaultName: "v", key: "token", value: token },
        ],
      })],
      () =>
        runRunnerAnswering({
          sessionCredential: "dispatch-cred",
          dataPlaneUrl: "http://127.0.0.1:9",
          cacheDirPath,
          dispatch: {
            dispatchId: crypto.randomUUID(),
            leaseId: crypto.randomUUID(),
            execution: {
              protocolVersion: REMOTE_PROTOCOL_VERSION,
              modelType: type.normalized,
              modelId: definitionId,
              methodName: "run",
              globalArgs,
              methodArgs,
              definitionMeta: {
                id: definitionId,
                name: "v6",
                version: 1,
                tags: {},
              },
            },
            bundleFingerprint: `builtin:${type.normalized}`,
            reportBundleFingerprints: [],
            environmentSnapshot: {},
            referenceBag: serveBag.referenceEntriesFor({
              globalArgs,
              methodArgs,
            }),
          },
        }),
    );
    assertEquals(run.result?.status, "success", run.result?.error);
    assertEquals(received, [{ token, endpoint: "https://api.example.com" }]);
    // One load, through the route, under the dispatch credential.
    assertEquals(calls.length, 1);
    assertEquals(new URL(calls[0].url).pathname, DISPATCH_SECRETS_PATH);
    assertEquals(run.calls, ["runner.argumentsValidated"]);
    assert(run.result?.logs.includes(`token ***`));
    assertEquals(
      run.result?.logs.filter((line) => line.includes(token)),
      [],
    );
  } finally {
    modelRegistry.invalidateType(type);
    await Deno.remove(cacheDirPath, { recursive: true }).catch(() => {});
  }
});

Deno.test("runDispatchRunner: a version 6 dispatch that carries a plaintext field is refused before anything loads", async () => {
  const cacheDirPath = await Deno.makeTempDir({ prefix: "swamp-runner-test-" });
  try {
    const bootstrap = bootstrapFor(cacheDirPath, "test/no-such-model", "s3c");
    bootstrap.dispatch.execution.protocolVersion = REMOTE_PROTOCOL_VERSION;
    const { result: run, calls } = await withMockedFetch(
      [],
      () => runRunnerAnswering(bootstrap),
    );
    assertEquals(run.result?.status, "error");
    assertStringIncludes(
      run.result?.error ?? "",
      "Refusing a protocol version 6 dispatch that carries secretValues",
    );
    assertEquals(calls, []);
  } finally {
    await Deno.remove(cacheDirPath, { recursive: true }).catch(() => {});
  }
});
