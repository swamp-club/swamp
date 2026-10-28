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

/**
 * A mixed fleet under one serve during the typed-secrets 5.2 window
 * (design/enablers/typed-secrets.md Section 9): a protocol version 5 worker
 * and a protocol version 6 worker run the same secret-bearing step through
 * the real MethodExecutionService → DispatchService → WorkerGateway path and
 * the real dispatch runner, in-process. The version 6 dispatch carries
 * references only and its runner loads each value through the protected
 * route; the version 5 dispatch keeps today's plaintext frame.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import {
  defineModel,
  type MethodContext,
  modelRegistry,
} from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { setRemoteStepDispatcher } from "../src/domain/remote/remote_dispatch.ts";
import {
  ARGUMENTS_VALIDATED_EVENT,
  DispatchParamsSchema,
  type DispatchResult,
  LEGACY_PLAINTEXT_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  type RpcStreamEvent,
  WorkerMethod,
} from "../src/domain/remote/protocol.ts";
import { StdioTransport } from "../src/domain/remote/stdio_transport.ts";
import { SecretBagRegistry } from "../src/domain/vaults/secret_bag_registry.ts";
import { SecretLoader } from "../src/domain/vaults/secret_loader.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { createExtensionCelEnvironment } from "../src/infrastructure/cel/cel_evaluator.ts";
import { runDispatchRunner } from "../src/worker/exec_dispatch.ts";
import {
  DataPlaneClient,
  DispatchSecretLoadError,
} from "../src/worker/data_plane_client.ts";
import {
  RUNNER_ARGUMENTS_VALIDATED,
  type RunnerBootstrapParams,
} from "../src/worker/runner_protocol.ts";
import {
  BASELINE_VAULT,
  type BaselineOrchestrator,
  canary,
  connectInMemoryWorker,
  type InMemoryWorker,
  startBaselineOrchestrator,
  withTempDir,
} from "./remote_secrets_baseline_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };

/** What the step's method received, by the worker that ran it. */
interface Received {
  token: unknown;
  endpoint: unknown;
}

/** A per-run model whose method records what it receives. */
function registerFleetModel(received: Received[]): ModelType {
  const type = ModelType.create(`test/mixed-fleet-${crypto.randomUUID()}`);
  defineModel({
    type,
    version: "2026.10.28.1",
    globalArguments: z.object({ endpoint: z.string().min(1) }),
    methods: {
      run: {
        description: "records the token and endpoint it receives",
        kind: "action",
        arguments: z.object({ token: z.string() }),
        execute: (args, context) => {
          received.push({
            token: (args as { token: string }).token,
            endpoint: context.globalArgs.endpoint,
          });
          return Promise.resolve({});
        },
      },
    },
  });
  return type;
}

/**
 * Runs one dispatch through the real runner in this process. As the
 * supervisor does, the runner's report that its arguments passed is streamed
 * to serve as it arrives, ahead of the result.
 */
async function runInProcess(
  bootstrap: RunnerBootstrapParams,
  stream: (event: RpcStreamEvent) => void,
): Promise<DispatchResult> {
  const stdin = new TransformStream<Uint8Array, Uint8Array>();
  const stdinWriter = new StdioTransport(stdin.writable);
  stdinWriter.send(JSON.stringify(bootstrap));
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
        } else if (
          frame.type === "rpc.request" &&
          frame.method === RUNNER_ARGUMENTS_VALIDATED
        ) {
          stream({ kind: ARGUMENTS_VALIDATED_EVENT });
        }
      }
    },
  });
  await runDispatchRunner(stdin.readable, stdout);
  stdinWriter.close();
  await stdin.writable.close();
  assert(result, "the runner sent a result frame");
  return result;
}

/**
 * Answers `worker`'s dispatches by running them through the real runner,
 * keeping each raw frame as it arrived.
 */
function runDispatches(
  o: BaselineOrchestrator,
  worker: InMemoryWorker,
  cacheDirPath: string,
  frames: Record<string, unknown>[],
): void {
  worker.channel.register(WorkerMethod.dispatch, async (raw, ctx) => {
    const frame = structuredClone(raw as Record<string, unknown>);
    frames.push(frame);
    return await runInProcess({
      sessionCredential: frame.dispatchCredential as string,
      dataPlaneUrl: o.dataPlaneUrl,
      cacheDirPath,
      dispatch: DispatchParamsSchema.parse(frame),
    }, (event) => ctx.stream(event));
  });
}

/** Counts the reads the protected route makes of serve's vault. */
function countingVault(reads: string[]) {
  return (vault: VaultService): VaultService => {
    const get = vault.get.bind(vault);
    vault.get = (vaultName, key, callerContext) => {
      reads.push(key);
      return get(vaultName, key, callerContext);
    };
    return vault;
  };
}

/**
 * Runs the fleet model's step on the worker the `tier` label selects, with
 * its method argument and global argument each a vault reference, through
 * executeWorkflow as a workflow step runs it. Returns what serve's own
 * loader read and how often the evaluation hook was called.
 */
async function runStep(
  o: BaselineOrchestrator,
  type: ModelType,
  tier: string,
  keys: { token: string; endpoint: string },
): Promise<{ serveReads: string[]; validated: number }> {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const tokenSentinel = bag.addSecret(
    { vaultName: BASELINE_VAULT, key: keys.token },
    "methods.run.arguments.token",
  );
  const endpointSentinel = bag.addSecret(
    { vaultName: BASELINE_VAULT, key: keys.endpoint },
    "globalArguments.endpoint",
  );
  const definition = Definition.create({
    name: `fleet-${tier}`,
    globalArguments: { endpoint: endpointSentinel },
    methods: { run: { arguments: { token: tokenSentinel } } },
  });
  const serveReads: string[] = [];
  const vault = await VaultService.fromRepository(o.repoDir);
  const get = vault.get.bind(vault);
  vault.get = (vaultName, key, callerContext) => {
    serveReads.push(key);
    return get(vaultName, key, callerContext);
  };
  const context: MethodContext = {
    signal: new AbortController().signal,
    repoDir: o.repoDir,
    modelType: type,
    modelId: definition.id,
    globalArgs: {},
    definition: {
      id: definition.id,
      name: definition.name,
      version: definition.version,
      tags: definition.tags,
    },
    methodName: "run",
    logger: getLogger(["test", "mixed-fleet"]),
    dataRepository: o.repoContext.unifiedDataRepo,
    definitionRepository: o.repoContext.definitionRepo,
    extensionFile: () => {
      throw new Error("extensionFile is not used by a remote step");
    },
    createCelEnvironment: createExtensionCelEnvironment,
    placement: { labels: { tier } },
    vaultSecrets: bag,
  };
  let validated = 0;
  setRemoteStepDispatcher(o.dispatchService);
  try {
    await new DefaultMethodExecutionService().executeWorkflow(
      definition,
      modelRegistry.get(type)!,
      "run",
      context,
      {
        secretLoader: new SecretLoader(() => Promise.resolve(vault)),
        onArgumentsValidated: () => {
          validated++;
          return Promise.resolve();
        },
      },
    );
  } finally {
    setRemoteStepDispatcher(null);
  }
  return { serveReads, validated };
}

/** Every file under `dir` whose text holds `needle`, by relative path. */
async function filesHolding(dir: string, needle: string): Promise<string[]> {
  const holding: string[] = [];
  for await (const entry of walk(dir, { includeDirs: false })) {
    const text = new TextDecoder().decode(await Deno.readFile(entry.path));
    if (text.includes(needle)) holding.push(entry.path.slice(dir.length));
  }
  return holding;
}

Deno.test({
  name:
    "remote secrets mixed fleet: a version 5 and a version 6 worker under one serve both deliver the exact values; only the version 6 frame is free of plaintext, and it loads each reference once through the route",
  ...SANITIZE,
  fn: async () => {
    await withTempDir(async (dir) => {
      const routeReads: string[] = [];
      const o = await startBaselineOrchestrator(dir, {
        wrapDataPlaneVault: countingVault(routeReads),
      });
      const received: Received[] = [];
      const type = registerFleetModel(received);
      try {
        const token = canary("fleet-token");
        const endpoint = `https://${crypto.randomUUID()}.example.com`;
        const keys = {
          token: `fleet-token-${crypto.randomUUID()}`,
          endpoint: `fleet-endpoint-${crypto.randomUUID()}`,
        };
        await o.putSecret(keys.token, token);
        await o.putSecret(keys.endpoint, endpoint);

        const v5Frames: Record<string, unknown>[] = [];
        const v6Frames: Record<string, unknown>[] = [];
        const v5 = await connectInMemoryWorker(
          o,
          "fleet-v5",
          { tier: "v5" },
          LEGACY_PLAINTEXT_PROTOCOL_VERSION,
        );
        const v6 = await connectInMemoryWorker(
          o,
          "fleet-v6",
          { tier: "v6" },
          REMOTE_PROTOCOL_VERSION,
        );
        assertEquals(
          [v5.enrollResult.protocolVersion, v6.enrollResult.protocolVersion],
          [LEGACY_PLAINTEXT_PROTOCOL_VERSION, REMOTE_PROTOCOL_VERSION],
        );
        runDispatches(o, v5, join(dir, "cache-v5"), v5Frames);
        runDispatches(o, v6, join(dir, "cache-v6"), v6Frames);

        // Version 5: serve loads both references and ships the values.
        const legacy = await runStep(o, type, "v5", keys);
        assertEquals(
          legacy.serveReads.toSorted(),
          [keys.endpoint, keys.token].toSorted(),
        );
        assertEquals(routeReads, []);
        assertEquals(legacy.validated, 1);
        const v5Frame = JSON.stringify(v5Frames[0]);
        assert(
          v5Frame.includes(token),
          "the version 5 frame carries plaintext",
        );

        // Version 6: serve loads nothing; the runner loads each reference
        // once, through the route, and validates on the worker.
        const current = await runStep(o, type, "v6", keys);
        assertEquals(current.serveReads, []);
        assertEquals(
          routeReads.toSorted(),
          [keys.endpoint, keys.token].toSorted(),
        );
        assertEquals(current.validated, 1);
        const v6Frame = JSON.stringify(v6Frames[0]);
        for (const value of [token, endpoint]) {
          assertEquals(v6Frame.includes(value), false);
        }
        assertEquals(
          (v6Frames[0].execution as { protocolVersion: number })
            .protocolVersion,
          REMOTE_PROTOCOL_VERSION,
        );

        // The method received the exact values on both workers.
        assertEquals(received, [
          { token, endpoint },
          { token, endpoint },
        ]);

        // No lease record, pending-dispatch record or other file serve or
        // the workers wrote holds the value (the vault stores it encrypted).
        assertEquals(await filesHolding(dir, token), []);
      } finally {
        modelRegistry.invalidateType(type);
        await o.shutdown();
      }
    });
  },
});

Deno.test({
  name:
    "remote secrets mixed fleet: a version 6 step re-dispatched after its worker is lost sends references again and loads them again, and the lost worker's credential reads nothing",
  ...SANITIZE,
  fn: async () => {
    await withTempDir(async (dir) => {
      const routeReads: string[] = [];
      const o = await startBaselineOrchestrator(dir, {
        wrapDataPlaneVault: countingVault(routeReads),
      });
      const received: Received[] = [];
      const type = registerFleetModel(received);
      try {
        const token = canary("redispatch-token");
        const keys = {
          token: `redispatch-token-${crypto.randomUUID()}`,
          endpoint: `redispatch-endpoint-${crypto.randomUUID()}`,
        };
        await o.putSecret(keys.token, token);
        await o.putSecret(keys.endpoint, "https://api.example.com");

        // The first worker loads the dispatch's references, then its
        // socket drops before it answers: a no-write attempt, so serve
        // re-dispatches the step. It drops only once the second worker is
        // in the pool, so the re-dispatch has somewhere to go.
        const lost = await connectInMemoryWorker(o, "lost", { tier: "v6" });
        const lostCredential: { value?: string } = {};
        const firstFrames: Record<string, unknown>[] = [];
        const nextEnrolled = Promise.withResolvers<void>();
        lost.channel.register(WorkerMethod.dispatch, async (raw) => {
          const frame = raw as Record<string, unknown>;
          firstFrames.push(structuredClone(frame));
          lostCredential.value = frame.dispatchCredential as string;
          const client = new DataPlaneClient({
            baseUrl: o.dataPlaneUrl,
            credential: () => lostCredential.value!,
          });
          await client.loadSecrets([
            { vaultName: BASELINE_VAULT, key: keys.token },
          ]);
          await nextEnrolled.promise;
          lost.dropSocket();
          throw new Error("worker lost");
        });
        const step = runStep(o, type, "v6", keys);
        await waitFor(
          () => firstFrames.length === 1 && routeReads.length === 1,
          "the first worker to load its dispatch's references",
        );

        const frames: Record<string, unknown>[] = [];
        const next = await connectInMemoryWorker(o, "next", { tier: "v6" });
        next.channel.register(WorkerMethod.dispatch, async (raw, ctx) => {
          const frame = structuredClone(raw as Record<string, unknown>);
          frames.push(frame);
          return await runInProcess({
            sessionCredential: frame.dispatchCredential as string,
            dataPlaneUrl: o.dataPlaneUrl,
            cacheDirPath: join(dir, "cache-next"),
            dispatch: DispatchParamsSchema.parse(frame),
          }, (event) => ctx.stream(event));
        });
        nextEnrolled.resolve();
        await step;

        // Both attempts carried references only, and each loaded them
        // itself: one load per reference per attempt.
        assertEquals(firstFrames.length, 1);
        assertEquals(frames.length, 1);
        for (const frame of [firstFrames[0], frames[0]]) {
          assertEquals(JSON.stringify(frame).includes(token), false);
          assert(Array.isArray(frame.referenceBag));
        }
        assert(frames[0].dispatchId !== firstFrames[0].dispatchId);
        assertEquals(
          routeReads.filter((key) => key === keys.token).length,
          2,
        );
        assertEquals(received.length, 1);
        assertEquals(received[0].token, token);
        assertEquals((await step).validated, 1);

        // The lost attempt's credential reads nothing now.
        const client = new DataPlaneClient({
          baseUrl: o.dataPlaneUrl,
          credential: () => lostCredential.value!,
        });
        const error = await assertRejects(
          () =>
            client.loadSecrets([
              { vaultName: BASELINE_VAULT, key: keys.token },
            ]),
          DispatchSecretLoadError,
        );
        assert(
          ["unauthenticated", "access_ended"].includes(error.code),
          error.code,
        );
      } finally {
        modelRegistry.invalidateType(type);
        await o.shutdown();
      }
    });
  },
});
