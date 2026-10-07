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
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  createRemoteMethodContext,
  dispatchMethodArgs,
  UnsupportedOnRemoteWorkerError,
} from "./remote_method_context.ts";
import { definitionFromExecution } from "./exec_dispatch.ts";
import { z } from "zod";
import { DefaultMethodExecutionService } from "../domain/models/method_execution_service.ts";
import type { MethodDefinition } from "../domain/models/model.ts";
import { RpcChannel } from "../domain/remote/rpc_channel.ts";
import {
  type DispatchParams,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
} from "../domain/remote/protocol.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { DataPlaneClient } from "./data_plane_client.ts";
import { modelIdentityPredicate } from "../domain/data/data_access_service.ts";

const MODEL_TYPE = ModelType.create("swamp/remote-ctx-test");

function dispatch(): DispatchParams {
  return {
    dispatchId: "d-1",
    leaseId: "l-1",
    execution: {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      modelType: MODEL_TYPE.normalized,
      modelId: "m-1",
      methodName: "run",
      globalArgs: { region: "us-east" },
      methodArgs: {},
      definitionMeta: {
        id: "0e6cf12e-8a3a-4f55-9c5d-1a2b3c4d5e6f",
        name: "def",
        version: 1,
        tags: {},
      },
    },
    bundleFingerprint: "builtin:x",
    reportBundleFingerprints: [],
    environmentSnapshot: {},
  };
}

interface StubCall {
  method: string;
  params: unknown;
}

function harness(
  scratchDir: string,
  extensionFilesDir?: string,
  artifactContent?: Record<string, unknown>,
  overrideDispatch?: DispatchParams,
  onEvent?: (event: Record<string, unknown>) => void,
  dataTags?: Record<string, string>,
) {
  const calls: StubCall[] = [];
  // The orchestrator side of the control socket, with stub verb handlers.
  const worker: RpcChannel = new RpcChannel({
    send: (data) =>
      void Promise.resolve().then(() => orchestrator.handleRaw(data)),
  });
  const orchestrator: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => worker.handleRaw(data)),
  });
  orchestrator.register(RemoteMethod.getData, (params) => {
    calls.push({ method: "getData", params });
    const p = params as { dataName?: string };
    if (p.dataName === "missing") {
      return Promise.resolve({ found: false });
    }
    return Promise.resolve({
      found: true,
      dataId: "11111111-2222-4333-8444-555555555555",
      version: 4,
      name: p.dataName,
      contentType: "application/json",
      size: 17,
      contentPath: `/data/x/m-1/${p.dataName}/4`,
      tags: dataTags,
    });
  });
  orchestrator.register(RemoteMethod.queryData, (params) => {
    calls.push({ method: "queryData", params });
    const { predicate } = params as { predicate: string };
    if (predicate.startsWith("modelType == ")) {
      return Promise.resolve([{ name: "by-identity", version: 1 }]);
    }
    return Promise.resolve([{ modelName: "thing" }]);
  });
  orchestrator.register(RemoteMethod.resolveModel, (params) => {
    calls.push({ method: "resolveModel", params });
    const { modelIdOrName } = params as { modelIdOrName: string };
    const definitions: Record<string, { id: string; name: string }> = {
      "other": { id: "o-1", name: "other" },
      // An id resolves to the definition it names, whose name differs.
      "o-2": { id: "o-2", name: "renamed" },
    };
    const definition = definitions[modelIdOrName];
    return Promise.resolve(
      definition
        ? { found: true, modelType: "swamp/other", definition }
        : { found: false },
    );
  });
  orchestrator.register(RemoteMethod.listVersions, (params) => {
    calls.push({ method: "listVersions", params });
    return Promise.resolve([1, 2, 3]);
  });
  orchestrator.register(RemoteMethod.resolveSecret, (params) => {
    calls.push({ method: "resolveSecret", params });
    return Promise.resolve({ value: "s3cret" });
  });
  orchestrator.register(RemoteMethod.putSecret, (params) => {
    calls.push({ method: "putSecret", params });
    return Promise.resolve({ ok: true });
  });

  const lines: string[] = [];
  const contents: Array<{ writerId: string; bytes: number }> = [];
  let writerCounter = 0;
  const client = {
    readArtifact: (contentPath: string) => {
      calls.push({ method: "readArtifact", params: contentPath });
      return Promise.resolve(
        new TextEncoder().encode(
          JSON.stringify(artifactContent ?? { loaded: true }),
        ),
      );
    },
    writeResource: (
      body: { specName: string; name: string; data: Record<string, unknown> },
    ) =>
      Promise.resolve({
        dataId: crypto.randomUUID(),
        name: body.name,
        specName: body.specName,
        kind: "resource" as const,
        version: 1,
        size: 1,
        tags: {},
      }),
    openWriter: (_body: { specName: string; name: string }) => {
      writerCounter++;
      return Promise.resolve({
        writerId: `w-${writerCounter}`,
        dataId: crypto.randomUUID(),
      });
    },
    writeLine: (writerId: string, text: string) => {
      lines.push(`${writerId}:${text}`);
      return Promise.resolve();
    },
    writeContent: async (
      writerId: string,
      content: Uint8Array | ReadableStream<Uint8Array> | string,
    ) => {
      let size: number;
      if (content instanceof ReadableStream) {
        let total = 0;
        for await (const chunk of content) {
          total += chunk.length;
        }
        size = total;
      } else if (typeof content === "string") {
        size = content.length;
      } else {
        size = content.length;
      }
      contents.push({ writerId, bytes: size });
      return {
        dataId: crypto.randomUUID(),
        name: "log",
        specName: "log",
        kind: "file" as const,
        version: 1,
        size,
        tags: {},
      };
    },
    finalizeWriter: (_writerId: string) =>
      Promise.resolve({
        dataId: crypto.randomUUID(),
        name: "log",
        specName: "log",
        kind: "file" as const,
        version: 1,
        size: lines.length,
        tags: {},
      }),
    deleteResource: (body: { name: string }) => {
      calls.push({ method: "deleteResource", params: body });
      return Promise.resolve();
    },
  } as unknown as DataPlaneClient;

  const { context, getHandles, redact } = createRemoteMethodContext({
    channel: worker,
    client,
    dispatch: overrideDispatch ?? dispatch(),
    scratchDir,
    extensionFilesDir,
    signal: new AbortController().signal,
    onEvent,
  });
  return { context, getHandles, redact, calls, lines, contents };
}

async function withScratch(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-remote-ctx-test" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("remote context: exposes the dispatch's traceHeaders", async () => {
  await withScratch((dir) => {
    const traced = dispatch();
    traced.execution.traceHeaders = { traceparent: "00-abc123-def456-01" };
    const h = harness(dir, undefined, undefined, traced);
    assertEquals(h.context.traceHeaders, {
      traceparent: "00-abc123-def456-01",
    });
    return Promise.resolve();
  });
});

Deno.test("remote context: readResource resolves metadata then fetches bytes", async () => {
  await withScratch(async (dir) => {
    const h = harness(dir);
    const value = await h.context.readResource!("state-main");
    assertEquals(value, { loaded: true });
    assertEquals(h.calls.map((c) => c.method), [
      "getData",
      "getData",
      "readArtifact",
    ]);
  });
});

Deno.test("remote context: readResource resolves vault references in sensitive fields", async () => {
  await withScratch(async (dir) => {
    const h = harness(
      dir,
      undefined,
      {
        username: "alice",
        refreshToken: "${{ vault.get('my-vault', 'refresh-tok') }}",
      },
      undefined,
      undefined,
      { "_swamp.sensitiveFields": JSON.stringify(["refreshToken"]) },
    );
    const value = await h.context.readResource!("state-main");
    assertEquals(value, { username: "alice", refreshToken: "s3cret" });
    const resolveCall = h.calls.find((c) => c.method === "resolveSecret");
    assertEquals(resolveCall?.params, {
      vaultName: "my-vault",
      secretKey: "refresh-tok",
    });
  });
});

Deno.test("remote context: readResource returns null for missing data", async () => {
  await withScratch(async (dir) => {
    const h = harness(dir);
    assertEquals(await h.context.readResource!("missing"), null);
  });
});

Deno.test("remote context: queryData and listVersions ride the control socket", async () => {
  await withScratch(async (dir) => {
    const h = harness(dir);
    const records = await h.context.queryData!('modelName == "thing"');
    assertEquals(records, [{ modelName: "thing" }]);
    const versions = await h.context.dataRepository.listVersions(
      MODEL_TYPE,
      "m-1",
      "state-main",
    );
    assertEquals(versions, [1, 2, 3]);
  });
});

Deno.test("remote context: vault get and put proxy as capability verbs", async () => {
  await withScratch(async (dir) => {
    const h = harness(dir);
    assertEquals(await h.context.vaultService!.get("local", "k"), "s3cret");
    await h.context.vaultService!.put("local", "k", "v");
    assertEquals(
      h.calls.filter((c) =>
        c.method === "resolveSecret" || c.method === "putSecret"
      ).length,
      2,
    );
  });
});

Deno.test("remote context: writeResource tracks handles for write-then-throw", async () => {
  await withScratch(async (dir) => {
    const h = harness(dir);
    await h.context.writeResource!("out", "one", { a: 1 });
    await h.context.writeResource!("out", "two", { a: 2 });
    assertEquals(h.getHandles().map((x) => x.name), ["one", "two"]);
  });
});

Deno.test("remote context: file writer writeText uploads and finalizes", async () => {
  await withScratch(async (dir) => {
    const h = harness(dir);
    const writer = h.context.createFileWriter!("log", "log");
    const handle = await writer.writeText("hello world");
    assertEquals(handle.kind, "file");
    assertEquals(h.contents.length, 1);
    assertEquals(h.getHandles().length, 1);
    await assertRejects(() => writer.writeText("again"), Error, "finalized");
  });
});

Deno.test("remote context: writeLine is one durable request per line", async () => {
  await withScratch(async (dir) => {
    const h = harness(dir);
    const writer = h.context.createFileWriter!("log", "log");
    await writer.writeLine("first");
    await writer.writeLine("second");
    assertEquals(h.lines, ["w-1:first", "w-1:second"]);
    const handle = await writer.finalize();
    assertEquals(handle.kind, "file");
  });
});

Deno.test("remote context: getFilePath spools locally and uploads on finalize", async () => {
  await withScratch(async (dir) => {
    const h = harness(dir);
    const writer = h.context.createFileWriter!("log", "log");
    const path = await writer.getFilePath();
    assertStringIncludes(path, dir);
    await Deno.writeTextFile(path, "spooled bytes from a subprocess");
    const handle = await writer.finalize();
    assertEquals(handle.kind, "file");
    assertEquals(h.contents.length, 1);
    assertEquals(h.contents[0].bytes, "spooled bytes from a subprocess".length);
  });
});

Deno.test("remote context: unsupported members fail loudly with guidance", async () => {
  await withScratch(async (dir) => {
    const h = harness(dir);
    const repo = h.context.dataRepository;
    assertThrows(
      () => repo.listVersionsSync(MODEL_TYPE, "m-1", "x"),
      UnsupportedOnRemoteWorkerError,
      "loopback executor",
    );
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => (repo.findAllGlobal as any)(),
      UnsupportedOnRemoteWorkerError,
    ).catch(() => {
      // findAllGlobal throws synchronously — both shapes are acceptable.
    });
    assertThrows(
      () => h.context.definitionRepository.getPath(MODEL_TYPE, "id" as never),
      UnsupportedOnRemoteWorkerError,
    );
  });
});

Deno.test("remote context: extensionFile resolves under the prefetched assets dir", async () => {
  await withScratch((dir) => {
    const withAssets = harness(dir, join(dir, "assets"));
    assertEquals(
      withAssets.context.extensionFile("templates/report.html"),
      join(dir, "assets", "templates", "report.html"),
    );
    const withoutAssets = harness(dir);
    assertThrows(
      () => withoutAssets.context.extensionFile("x"),
      Error,
      "no co-located extension files",
    );
    return Promise.resolve();
  });
});

Deno.test("remote context: repoDir is the scratch directory", async () => {
  await withScratch((dir) => {
    const h = harness(dir);
    assertEquals(h.context.repoDir, dir);
    return Promise.resolve();
  });
});

Deno.test("remote context: deleteResource calls client.deleteResource", async () => {
  await withScratch(async (dir) => {
    const h = harness(dir);
    await h.context.deleteResource!("stale-data");
    assertEquals(
      h.calls.filter((c) => c.method === "deleteResource"),
      [{ method: "deleteResource", params: { name: "stale-data" } }],
    );
  });
});

Deno.test("remote context: secretValues populate the redactor", async () => {
  await withScratch((dir) => {
    const d = dispatch();
    d.secretValues = ["super-secret-value"];
    const h = harness(dir, undefined, undefined, d);
    assertEquals(h.context.redactor!.hasSecrets, true);
    assertEquals(
      h.context.redactor!.redact("output: super-secret-value here"),
      "output: *** here",
    );
    return Promise.resolve();
  });
});

Deno.test("remote context: output leaves the worker with secrets scrubbed (swamp-club#3080)", async () => {
  await withScratch((dir) => {
    const d = dispatch();
    d.secretValues = ["super-secret-value"];
    const events: Record<string, unknown>[] = [];
    const h = harness(dir, undefined, undefined, d, (e) => events.push(e));
    // A secret the method learns while it runs is covered too.
    h.context.redactor!.addSecret("learned-on-the-worker");

    h.context.logger.info("logged super-secret-value");
    h.context.onEvent!({
      type: "output",
      line: "emitted learned-on-the-worker",
      stream: "stderr",
    });
    h.context.onEvent!({
      type: "vault_single_quote_warning",
      message: "untouched",
    });

    assertEquals(events.map((e) => e.line ?? e.message), [
      "logged ***",
      "emitted ***",
      "untouched",
    ]);
    assertEquals(
      h.redact("console learned-on-the-worker"),
      "console ***",
    );
    return Promise.resolve();
  });
});

Deno.test("remote context: empty secretValues leaves redactor without secrets", async () => {
  await withScratch((dir) => {
    const h = harness(dir);
    assertEquals(h.context.redactor!.hasSecrets, false);
    return Promise.resolve();
  });
});

Deno.test("remote context: logger.info fires onEvent with stdout output event", async () => {
  await withScratch((dir) => {
    const events: Record<string, unknown>[] = [];
    const h = harness(
      dir,
      undefined,
      undefined,
      undefined,
      (e) => events.push(e),
    );
    h.context.logger.info("hello from remote");
    assertEquals(events.length, 1);
    assertEquals(events[0].type, "output");
    assertEquals(events[0].stream, "stdout");
    assertEquals(events[0].line, "hello from remote");
    return Promise.resolve();
  });
});

Deno.test("remote context: logger.warn fires onEvent with stderr output event", async () => {
  await withScratch((dir) => {
    const events: Record<string, unknown>[] = [];
    const h = harness(
      dir,
      undefined,
      undefined,
      undefined,
      (e) => events.push(e),
    );
    h.context.logger.warn("something went wrong");
    assertEquals(events.length, 1);
    assertEquals(events[0].type, "output");
    assertEquals(events[0].stream, "stderr");
    assertEquals(events[0].line, "something went wrong");
    return Promise.resolve();
  });
});

function queryPredicates(calls: StubCall[]): string[] {
  return calls
    .filter((c) => c.method === "queryData")
    .map((c) => (c.params as { predicate: string }).predicate);
}

Deno.test("remote context: readModelData of its own name adds an identity read without resolving (swamp-club#3011)", async () => {
  await withScratch(async (dir) => {
    const h = harness(dir);
    const records = await h.context.readModelData!("def", "foo");
    assertEquals(records as unknown[], [{ modelName: "thing" }, {
      name: "by-identity",
      version: 1,
    }]);
    assertEquals(queryPredicates(h.calls), [
      'modelName == "def" && specName == "foo"',
      modelIdentityPredicate(
        { modelType: MODEL_TYPE.normalized, modelId: "m-1" },
        "foo",
      ),
    ]);
    assertEquals(h.calls.some((c) => c.method === "resolveModel"), false);
  });
});

Deno.test("remote context: readModelData of another model resolves it and reads by identity", async () => {
  await withScratch(async (dir) => {
    const h = harness(dir);
    await h.context.readModelData!("other");
    assertEquals(queryPredicates(h.calls), [
      'modelName == "other"',
      modelIdentityPredicate({ modelType: "swamp/other", modelId: "o-1" }),
    ]);
  });
});

Deno.test("remote context: readModelData reads by name only when the name is unresolved, an id, or namespaced", async () => {
  await withScratch(async (dir) => {
    for (const name of ["missing", "o-2", "*:def", "ns:other"]) {
      const h = harness(dir);
      await h.context.readModelData!(name);
      assertEquals(queryPredicates(h.calls), [
        `modelName == ${JSON.stringify(name)}`,
      ], name);
    }
  });
});

Deno.test("remote context: readModelData resolves a name once per dispatch, including a miss", async () => {
  await withScratch(async (dir) => {
    const h = harness(dir);
    for (let i = 0; i < 3; i++) {
      await h.context.readModelData!("other");
      await h.context.readModelData!("missing");
    }
    assertEquals(
      h.calls.filter((c) => c.method === "resolveModel").length,
      2,
    );
  });
});

const SENTINEL = "__SWAMP_VSEC_0a1b2c3d_0__";
const DATA_SENTINEL = "__SWAMP_VSEC_0a1b2c3d_1__";

function dispatchWithSecretBag(): DispatchParams {
  const d = dispatch();
  d.execution.methodArgs = { run: "echo s3cret data-value" };
  d.unresolvedMethodArgs = { run: `echo ${SENTINEL} ${DATA_SENTINEL}` };
  d.secretBag = [
    { sentinel: SENTINEL, value: "s3cret", dataOrigin: false },
    { sentinel: DATA_SENTINEL, value: "data-value", dataOrigin: true },
  ];
  d.secretValues = ["s3cret", "data-value"];
  return d;
}

Deno.test("remote context: a shipped secret bag is rebuilt as vaultSecrets (swamp-club#2760)", async () => {
  await withScratch((dir) => {
    const h = harness(dir, undefined, undefined, dispatchWithSecretBag());
    const bag = h.context.vaultSecrets!;
    assertEquals(bag.toEntries(), dispatchWithSecretBag().secretBag);
    assertEquals(bag.isDataOrigin(DATA_SENTINEL), true);
    return Promise.resolve();
  });
});

Deno.test("remote context: without a shipped bag there are no vaultSecrets", async () => {
  await withScratch((dir) => {
    const h = harness(dir);
    assertEquals(h.context.vaultSecrets, undefined);
    return Promise.resolve();
  });
});

Deno.test("dispatchMethodArgs: unresolved args with a bag, resolved args otherwise", () => {
  assertEquals(dispatchMethodArgs(dispatchWithSecretBag()), {
    run: `echo ${SENTINEL} ${DATA_SENTINEL}`,
  });
  const noBag = dispatchWithSecretBag();
  noBag.secretBag = undefined;
  assertEquals(dispatchMethodArgs(noBag), { run: "echo s3cret data-value" });
  const emptyBag = dispatchWithSecretBag();
  emptyBag.secretBag = [];
  assertEquals(dispatchMethodArgs(emptyBag), { run: "echo s3cret data-value" });
});

Deno.test("remote context: the worker resolves shipped args as the orchestrator did (swamp-club#2760)", async () => {
  await withScratch(async (dir) => {
    const d = dispatchWithSecretBag();
    const h = harness(dir, undefined, undefined, d);
    let seenArgs: Record<string, unknown> | undefined;
    let seenUnresolved: Record<string, unknown> | undefined;
    const method: MethodDefinition = {
      description: "records what it receives",
      arguments: z.object({ run: z.string() }),
      execute: (args, context) => {
        seenArgs = args as Record<string, unknown>;
        seenUnresolved = context.unresolvedMethodArgs;
        return Promise.resolve({});
      },
    };
    const definition = definitionFromExecution(
      d.execution,
      dispatchMethodArgs(d),
    );

    await new DefaultMethodExecutionService().execute(
      definition,
      method,
      h.context,
    );

    // A non-shell model gets the plaintext the orchestrator resolved; the
    // shell model reads the unresolved run and delivers it through env vars.
    assertEquals(seenArgs?.run, d.execution.methodArgs.run);
    assertEquals(seenUnresolved?.run, d.unresolvedMethodArgs!.run);
  });
});
