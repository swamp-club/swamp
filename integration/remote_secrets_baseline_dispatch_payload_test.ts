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

import { ProvenanceMap } from "../src/domain/expressions/provenance_map.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { z } from "zod";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { getLogger } from "@logtape/logtape";
import { Definition } from "../src/domain/definitions/definition.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import type {
  MethodContext,
  ModelDefinition,
} from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { setRemoteStepDispatcher } from "../src/domain/remote/remote_dispatch.ts";
import {
  type DispatchParams,
  DispatchParamsSchema,
  type DispatchResult,
  LEGACY_PLAINTEXT_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
  WorkerMethod,
} from "../src/domain/remote/protocol.ts";
import { RpcChannel } from "../src/domain/remote/rpc_channel.ts";
import {
  createStdioReader,
  StdioTransport,
} from "../src/domain/remote/stdio_transport.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import { SecretBagRegistry } from "../src/domain/vaults/secret_bag_registry.ts";
import { SecretLoader } from "../src/domain/vaults/secret_loader.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { createExtensionCelEnvironment } from "../src/infrastructure/cel/cel_evaluator.ts";
import {
  buildRunnerBootstrapParams,
  registerDispatchHandler,
} from "../src/worker/dispatch_handler.ts";
import { runDispatchRunner } from "../src/worker/exec_dispatch.ts";
import { RunnerBootstrapParamsSchema } from "../src/worker/runner_protocol.ts";
import { generateCanaries } from "./canary_values.ts";
import {
  type BaselineOrchestrator,
  canary,
  connectInMemoryWorker,
  startBaselineOrchestrator,
  withTempDir,
} from "./remote_secrets_baseline_harness.ts";

const REF = { vaultName: "v", key: "k" };

await initializeLogging({});

const LABELS = { tier: "baseline-payload" };

function payloadModel(): ModelDefinition {
  return {
    type: ModelType.create(`test/secrets-payload-${crypto.randomUUID()}`),
    version: "1",
    methods: {
      run: {
        description: "runs on a worker",
        arguments: z.object({
          token: z.string().meta({ sensitive: true }),
          note: z.string(),
        }),
        execute: () => Promise.resolve({}),
      },
    },
  };
}

interface Captured {
  raw: Record<string, unknown>;
}

async function dispatchStepWithSecret(
  o: BaselineOrchestrator,
  secret: string | readonly string[],
  sensitive: string,
  protocolVersion: number = REMOTE_PROTOCOL_VERSION,
): Promise<
  {
    captured: Captured;
    sentinel: string;
    sentinels: string[];
    reads: string[];
  }
> {
  const secrets = typeof secret === "string" ? [secret] : [...secret];
  const worker = await connectInMemoryWorker(
    o,
    `payload-${crypto.randomUUID().slice(0, 8)}`,
    LABELS,
    protocolVersion,
  );
  const captured: Captured = { raw: {} };
  worker.channel.register(WorkerMethod.dispatch, (params) => {
    captured.raw = structuredClone(params as Record<string, unknown>);
    return Promise.resolve<DispatchResult>({
      status: "success",
      outputs: [],
      logs: [],
      durationMs: 1,
    });
  });

  const bag = new VaultSecretBag(new SecretBagRegistry());
  const refs = secrets.map((_, i) =>
    i === 0 ? REF : { vaultName: REF.vaultName, key: `${REF.key}${i}` }
  );
  const sentinels = refs.map((ref) =>
    bag.addSecret(ref, "methods.run.arguments.note")
  );
  const reads: string[] = [];
  const vaultService = new class extends VaultService {
    override get(vaultName: string, key: string, caller?: string) {
      reads.push(key);
      return super.get(vaultName, key, caller);
    }
  }();
  vaultService.registerVault({
    name: REF.vaultName,
    type: "mock",
    config: Object.fromEntries(refs.map((ref, i) => [ref.key, secrets[i]])),
  });
  const sentinel = sentinels[0];
  const model = payloadModel();
  const definition = Definition.create({
    name: `payload-${crypto.randomUUID().slice(0, 8)}`,
    globalArguments: {},
    methods: {
      run: {
        arguments: { token: sensitive, note: `uses ${sentinels.join(" ")}` },
      },
    },
  });
  const context: MethodContext = {
    signal: new AbortController().signal,
    repoDir: o.repoDir,
    modelType: model.type,
    modelId: definition.id,
    globalArgs: {},
    definition: {
      id: definition.id,
      name: definition.name,
      version: definition.version,
      tags: definition.tags,
    },
    methodName: "run",
    logger: getLogger(["test", "secrets-baseline"]),
    dataRepository: o.repoContext.unifiedDataRepo,
    definitionRepository: o.repoContext.definitionRepo,
    extensionFile: () => {
      throw new Error("extensionFile is not used by a remote step");
    },
    createCelEnvironment: createExtensionCelEnvironment,
    placement: { labels: LABELS },
    vaultSecrets: bag,
  };

  setRemoteStepDispatcher(o.dispatchService);
  try {
    await new DefaultMethodExecutionService().executeWorkflow(
      definition,
      model,
      "run",
      context,
      {
        argumentProvenance: ProvenanceMap.authored(),
        secretLoader: new SecretLoader(() => Promise.resolve(vaultService)),
      },
    );
  } finally {
    setRemoteStepDispatcher(null);
  }
  return { captured, sentinel, sentinels, reads };
}

Deno.test({
  name:
    "remote secrets baseline: dispatch payload: a version 5 worker's WebSocket dispatch carries secrets in plaintext in args, secretValues and secretBag, the documented exception of the 5.2 window",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const o = await startBaselineOrchestrator(dir);
      try {
        const secret = canary("vault");
        const sensitive = canary("sensitive");
        const { captured, sentinel } = await dispatchStepWithSecret(
          o,
          secret,
          sensitive,
          LEGACY_PLAINTEXT_PROTOCOL_VERSION,
        );
        const raw = captured.raw;
        assertEquals(
          (raw.execution as Record<string, unknown>).protocolVersion,
          LEGACY_PLAINTEXT_PROTOCOL_VERSION,
        );

        // `lockHolder` rides along only when the test process inherits a
        // lock holder (a swamp workflow step running the suite sets one);
        // it carries no secret, so the key set leaves it out.
        assertEquals(
          Object.keys(raw).filter((k) => k !== "lockHolder").sort(),
          [
            "bundleFingerprint",
            "dispatchCredential",
            "dispatchId",
            "environmentSnapshot",
            "execution",
            "leaseId",
            "reportBundleFingerprints",
            "secretBag",
            "secretValues",
            "step",
            "unresolvedMethodArgs",
          ],
        );
        const execution = raw.execution as Record<string, unknown>;
        assertEquals(Object.keys(execution).sort(), [
          "definitionMeta",
          "globalArgs",
          "methodArgs",
          "methodName",
          "modelId",
          "modelType",
          "protocolVersion",
          "traceHeaders",
        ]);

        assertEquals(execution.methodArgs, {
          token: sensitive,
          note: `uses ${secret}`,
        });
        assertEquals(execution.globalArgs, {});
        assert(!JSON.stringify(execution.traceHeaders).includes(secret));
        assertEquals(
          [...(raw.secretValues as string[])].sort(),
          [secret, sensitive].sort(),
        );
        assertEquals(raw.secretBag, [{
          sentinel,
          value: secret,
          dataOrigin: false,
        }]);
        assertEquals(raw.unresolvedMethodArgs, {
          token: sensitive,
          note: `uses ${sentinel}`,
        });

        // The per-dispatch credential rides outside the schema: a schema
        // parse, as the supervisor does, drops it.
        assertEquals(typeof raw.dispatchCredential, "string");
        assert((raw.dispatchCredential as string).length > 0);
        const parsed = DispatchParamsSchema.parse(raw);
        assertEquals("dispatchCredential" in parsed, false);
      } finally {
        await o.shutdown();
      }
    });
  },
});

Deno.test({
  name:
    "remote secrets baseline: dispatch payload: a version 5 runner bootstrap frame carries the whole dispatch, secret fields included, with the dispatch credential as its session credential",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const o = await startBaselineOrchestrator(dir);
      try {
        const secret = canary("vault");
        const sensitive = canary("sensitive");
        const { captured, sentinel } = await dispatchStepWithSecret(
          o,
          secret,
          sensitive,
          LEGACY_PLAINTEXT_PROTOCOL_VERSION,
        );
        const raw = captured.raw;

        const frame = buildRunnerBootstrapParams(
          DispatchParamsSchema.parse(raw),
          raw.dispatchCredential as string,
          {
            sessionCredential: () => "control-credential",
            dataPlaneUrl: o.dataPlaneUrl,
            cacheDirPath: dir,
          },
        );
        const wire = RunnerBootstrapParamsSchema.parse(
          JSON.parse(JSON.stringify(frame)),
        );

        assertEquals(Object.keys(wire).sort(), [
          "cacheDirPath",
          "dataPlaneUrl",
          "dispatch",
          "sessionCredential",
        ]);
        assertEquals(wire.sessionCredential, raw.dispatchCredential);
        assertNotEquals(wire.sessionCredential, "control-credential");
        assertEquals("dispatchCredential" in wire.dispatch, false);
        assertEquals(wire.dispatch.execution.methodArgs, {
          token: sensitive,
          note: `uses ${secret}`,
        });
        assertEquals(
          [...(wire.dispatch.secretValues ?? [])].sort(),
          [secret, sensitive].sort(),
        );
        assertEquals(wire.dispatch.secretBag, [{
          sentinel,
          value: secret,
          dataOrigin: false,
        }]);
        assertEquals(wire.dispatch.unresolvedMethodArgs, {
          token: sensitive,
          note: `uses ${sentinel}`,
        });
      } finally {
        await o.shutdown();
      }
    });
  },
});

Deno.test("remote secrets baseline: dispatch payload: REMOTE_PROTOCOL_VERSION is 6, and serve enrolls 5 and 6", () => {
  assertEquals(REMOTE_PROTOCOL_VERSION, 6);
  assertEquals(LEGACY_PLAINTEXT_PROTOCOL_VERSION, 5);
});

for (const refusedVersion of [4, 7]) {
  Deno.test({
    name:
      `remote secrets baseline: dispatch payload: enrollment at protocol version ${refusedVersion} is refused with protocol_mismatch and registers no worker`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await withTempDir(async (dir) => {
        const o = await startBaselineOrchestrator(dir);
        try {
          const name = `mismatch-${crypto.randomUUID().slice(0, 8)}`;
          const token = await o.mintToken(name);
          const channel: RpcChannel = new RpcChannel({
            send: (data) =>
              void Promise.resolve().then(() => attached.feed(data)),
          });
          const attached = o.gateway.attachTransport({
            send: (data) =>
              void Promise.resolve().then(() => channel.handleRaw(data)),
          }, () => attached.closed());

          let code: unknown;
          try {
            await channel.call(RemoteMethod.enroll, {
              token,
              instanceUuid: crypto.randomUUID(),
              machineId: "machine-mismatch",
              protocolVersion: refusedVersion,
              swampVersion: "test",
              platform: "linux",
              arch: "x86_64",
              labels: {},
            });
          } catch (error) {
            code = (error as { code?: unknown }).code;
          }
          assertEquals(code, "protocol_mismatch");
          assertEquals(o.gateway.worker(name), null);
          const ok = await channel.call<{ protocolVersion: number }>(
            RemoteMethod.enroll,
            {
              token,
              instanceUuid: crypto.randomUUID(),
              machineId: "machine-mismatch",
              protocolVersion: REMOTE_PROTOCOL_VERSION,
              swampVersion: "test",
              platform: "linux",
              arch: "x86_64",
              labels: {},
            },
          );
          assertEquals(ok.protocolVersion, REMOTE_PROTOCOL_VERSION);
          assertNotEquals(o.gateway.worker(name), null);
        } finally {
          await o.shutdown();
        }
      });
    },
  });
}

function dispatchAt(protocolVersion: number): DispatchParams {
  return {
    dispatchId: crypto.randomUUID(),
    leaseId: crypto.randomUUID(),
    execution: {
      protocolVersion,
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
  };
}

async function runnerResultFor(
  dispatch: DispatchParams,
  cacheDirPath: string,
): Promise<DispatchResult> {
  const stdin = new TransformStream<Uint8Array, Uint8Array>();
  const stdinWriter = new StdioTransport(stdin.writable);
  stdinWriter.send(JSON.stringify({
    sessionCredential: "cred",
    dataPlaneUrl: "http://127.0.0.1:9",
    cacheDirPath,
    dispatch,
  }));
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
  const result = frames.map((f) => JSON.parse(f)).find((f) =>
    f.type === "runner.result"
  );
  assertExists(result, "the runner sent a result frame");
  return result.result as DispatchResult;
}

Deno.test("remote secrets baseline: dispatch payload: the runner does not check execution.protocolVersion", async () => {
  await withTempDir(async (dir) => {
    // an unknown model fails at bundle load; a version check would fail earlier
    // with a different error, but both versions fail the same way
    const current = await runnerResultFor(
      dispatchAt(REMOTE_PROTOCOL_VERSION),
      dir,
    );
    const mismatched = await runnerResultFor(
      dispatchAt(REMOTE_PROTOCOL_VERSION + 95),
      dir,
    );
    assertEquals(current.status, "error");
    assertEquals(mismatched.status, "error");
    assertEquals(mismatched.error, current.error);
    assert(!/protocol/i.test(mismatched.error ?? ""));
  });
});

Deno.test("remote secrets baseline: dispatch payload: the supervisor does not check execution.protocolVersion before spawning the runner", async () => {
  const peer: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => channel.handleRaw(data)),
  });
  const channel: RpcChannel = new RpcChannel({
    send: (data) => void Promise.resolve().then(() => peer.handleRaw(data)),
  });
  const started: string[] = [];
  registerDispatchHandler({
    channel,
    sessionCredential: () => "cred",
    dataPlaneUrl: "http://127.0.0.1:9",
    cacheDirPath: "/nonexistent-cache",
    capacity: 1,
    onDispatch: (event) => started.push(event.kind),
    // A command that does not exist: the spawn attempt fails with NotFound,
    // so no process starts. Reaching it proves nothing refused the version.
    runnerCommand: {
      cmd: `/nonexistent/swamp-baseline-runner-${crypto.randomUUID()}`,
      args: [],
    },
  });

  let failure: unknown;
  try {
    await peer.call(
      WorkerMethod.dispatch,
      dispatchAt(REMOTE_PROTOCOL_VERSION + 95),
    );
  } catch (error) {
    failure = error;
  }
  assertEquals(started, ["dispatch_started", "dispatch_finished"]);
  assert(failure instanceof Error);
  assertStringIncludes(failure.message, "Failed to spawn");
  peer.close("done");
  channel.close("done");
});

Deno.test({
  name:
    "remote secrets baseline: dispatch payload: a version 6 worker's WebSocket dispatch and runner bootstrap carry references only, no vault canary of any class, and serve loads nothing (typed-secrets 5.2)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withTempDir(async (dir) => {
      const o = await startBaselineOrchestrator(dir);
      try {
        const canaries = generateCanaries().filter((c) => c.unique);
        const sensitive = canary("sensitive-literal");
        const { captured, sentinels, reads } = await dispatchStepWithSecret(
          o,
          canaries.map((c) => c.value),
          sensitive,
        );
        const raw = captured.raw;

        assertEquals(reads, []);
        assertEquals(
          Object.keys(raw).filter((k) => k !== "lockHolder").sort(),
          [
            "bundleFingerprint",
            "dispatchCredential",
            "dispatchId",
            "environmentSnapshot",
            "execution",
            "leaseId",
            "referenceBag",
            "reportBundleFingerprints",
            "step",
          ],
        );
        const execution = raw.execution as Record<string, unknown>;
        assertEquals(execution.protocolVersion, REMOTE_PROTOCOL_VERSION);
        assertEquals(execution.methodArgs, {
          token: sensitive,
          note: `uses ${sentinels.join(" ")}`,
        });
        assertEquals(
          (raw.referenceBag as Array<Record<string, unknown>>).map((e) => ({
            sentinel: e.sentinel,
            vaultName: (e.reference as { vaultName: string }).vaultName,
            encoding: e.encoding,
            dataOrigin: e.dataOrigin,
            value: "value" in e,
          })),
          sentinels.map((sentinel) => ({
            sentinel,
            vaultName: REF.vaultName,
            encoding: "raw",
            dataOrigin: false,
            value: false,
          })),
        );

        const bootstrap = JSON.stringify(
          buildRunnerBootstrapParams(
            DispatchParamsSchema.parse(raw),
            raw.dispatchCredential as string,
            {
              sessionCredential: () => "control-credential",
              dataPlaneUrl: o.dataPlaneUrl,
              cacheDirPath: dir,
            },
          ),
        );
        const frame = JSON.stringify(raw);
        for (const c of canaries) {
          const escaped = JSON.stringify(c.value).slice(1, -1);
          for (const form of new Set([c.value, escaped])) {
            assertEquals(frame.includes(form), false, `${c.class} in dispatch`);
            assertEquals(
              bootstrap.includes(form),
              false,
              `${c.class} in bootstrap`,
            );
          }
        }

        assertEquals(
          (raw.referenceBag as Array<{ reference: unknown }>).length,
          canaries.length,
        );
      } finally {
        await o.shutdown();
      }
    });
  },
});
