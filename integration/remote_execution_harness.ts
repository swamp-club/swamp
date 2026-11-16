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

import { dirname, fromFileUrl, join } from "@std/path";

import { consumeStream, withDefaults } from "../src/libswamp/stream.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  createVaultCreateDeps,
  vaultCreate,
} from "../src/libswamp/vaults/create.ts";
import { createWorkerModelRunDeps } from "../src/libswamp/worker/run_deps.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { CapabilityService } from "../src/serve/capability_service.ts";
import { WorkerGateway } from "../src/serve/worker_gateway.ts";
import { DispatchService } from "../src/serve/dispatch_service.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import { BundleRegistry } from "../src/serve/bundle_registry.ts";
import { DataPlane } from "../src/serve/data_plane.ts";
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  tokenSecretKey,
} from "../src/domain/models/worker/enrollment_token_model.ts";
import { sweepStaleRecords } from "../src/serve/boot_reconciliation.ts";
import { forwardedPrefixOf } from "../src/cli/commands/serve.ts";
import { IT_DEFINITION_ID, IT_TYPE } from "./remote_execution_test_model.ts";

const MODULE_DIR = dirname(fromFileUrl(import.meta.url));
const RUNNER_ENTRY = join(
  MODULE_DIR,
  "test_fixtures",
  "remote_it_runner_entry.ts",
);
export const TEST_RUNNER_COMMAND = {
  cmd: Deno.execPath(),
  args: [
    "run",
    "--unstable-bundle",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run",
    "--allow-net",
    "--allow-sys",
    RUNNER_ENTRY,
  ],
};

export interface Orchestrator {
  repoDir: string;
  repoContext: ReturnType<typeof createRepositoryContext>;
  gateway: WorkerGateway;
  dispatchService: DispatchService;
  serverUrl: string;
  shutdown: () => Promise<void>;
  mintToken: (
    name: string,
    opts?: { maxEnrollments?: number | "unlimited" },
  ) => Promise<string>;
  runModelMethod: (input: {
    typeArg: string;
    definitionName: string;
    methodName: string;
    inputs: Record<string, unknown>;
  }) => Promise<void>;
}

export async function startOrchestrator(
  repoDir: string,
  opts?: { skipInit?: boolean; trustProxy?: boolean },
): Promise<Orchestrator> {
  if (!opts?.skipInit) {
    const libCtx = createLibSwampContext({});
    await consumeStream(
      repoInit(libCtx, createRepoInitDeps("20260101.120000.0"), {
        path: repoDir,
        force: false,
        version: "20260101.120000.0",
        // No tool scaffolding: the default ["claude"] would install bundled
        // skills into the real ~/.claude/skills.
        tools: [],
      }),
      withDefaults({
        error: (event) => {
          throw new Error(String(event.error?.message ?? "repo init failed"));
        },
      }),
    );
    await consumeStream(
      vaultCreate(libCtx, await createVaultCreateDeps(repoDir), {
        vaultType: "local_encryption",
        name: "local",
        config: { auto_generate: true, base_dir: repoDir },
        repoDir,
      }),
      withDefaults({
        error: (event) => {
          throw new Error(
            String(event.error?.message ?? "vault create failed"),
          );
        },
      }),
    );
  }

  const repoContext = createRepositoryContext({ repoDir });

  const runModelMethod = async (input: {
    typeArg: string;
    definitionName: string;
    methodName: string;
    inputs: Record<string, unknown>;
  }) => {
    const deps = await createWorkerModelRunDeps(repoDir, repoContext);
    for await (
      const event of modelMethodRun(createLibSwampContext({}), deps, {
        modelIdOrName: input.definitionName,
        methodName: input.methodName,
        inputs: input.inputs,
        lastEvaluated: false,
        typeArg: input.typeArg,
        definitionName: input.definitionName,
      })
    ) {
      if (event.kind === "error") {
        const detail = event.error as { message?: unknown };
        throw new Error(String(detail?.message ?? "model method failed"));
      }
    }
  };

  const capabilityService = new CapabilityService({ repoDir, repoContext });
  const dispatches = new DispatchRegistry();
  const bundles = new BundleRegistry();
  const dispatchService = new DispatchService({
    repoDir,
    repoContext,
    dispatches,
    bundles,
    queueTimeoutMs: 15_000,
    captureEnvironment: () => ({ REMOTE_IT_ENV: "shipped-value" }),
  });
  const gateway = new WorkerGateway({
    repoDir,
    repoContext,
    capabilityService,
    graceWindowMs: 1_000,
    onWorkerIdle: (worker) => dispatchService.notifyWorkerIdle(worker),
    onGraceExpired: (worker) => dispatchService.notifyGraceExpired(worker),
    onWorkerEnrolled: (worker) => dispatchService.notifyWorkerEnrolled(worker),
    onWorkerDraining: (worker) => dispatchService.notifyWorkerDraining(worker),
  });
  dispatchService.bindGateway(gateway);
  const dataPlane = new DataPlane({
    repoDir,
    repoContext,
    sessions: gateway.sessions,
    dispatches,
    bundles,
    workerReads: capabilityService,
    onFirstWrite: (dispatch) => dispatchService.recordFirstWrite(dispatch),
  });
  dispatchService.setOnDispatchEnd((id) => dataPlane.releaseDispatch(id));

  await sweepStaleRecords({ repoContext });

  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const upgrade = req.headers.get("upgrade") ?? "";
      if (upgrade.toLowerCase() === "websocket") {
        const forwardedPrefix = forwardedPrefixOf(
          req,
          opts?.trustProxy ?? false,
        );
        const { socket, response } = Deno.upgradeWebSocket(req);
        const attachment = gateway.attachTransport(
          {
            send: (data) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(data);
              }
            },
          },
          undefined,
          forwardedPrefix,
        );
        socket.onmessage = (event) => {
          if (typeof event.data === "string") {
            attachment.feed(event.data);
          }
        };
        socket.onclose = () => attachment.closed();
        return response;
      }
      const dataPlaneResponse = await dataPlane.handle(req);
      if (dataPlaneResponse) {
        return dataPlaneResponse;
      }
      return new Response("Not found", { status: 404 });
    },
  );
  const port = server.addr.port;

  const mintToken = async (
    name: string,
    opts?: { maxEnrollments?: number | "unlimited" },
  ): Promise<string> => {
    await runModelMethod({
      typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
      definitionName: name,
      methodName: "mint",
      inputs: {
        durationMs: 10 * 60 * 1000,
        vaultName: "local",
        ...(opts?.maxEnrollments !== undefined
          ? { maxEnrollments: opts.maxEnrollments }
          : {}),
      },
    });
    const vault = await VaultService.fromRepository(repoDir);
    const plaintext = await vault.get("local", tokenSecretKey(name));
    return `${name}.${plaintext}`;
  };

  return {
    repoDir,
    repoContext,
    gateway,
    dispatchService,
    serverUrl: `ws://127.0.0.1:${port}`,
    shutdown: async () => {
      await server.shutdown();
      // wait for the disconnect and queue records still being written, so they
      // land before the test removes the repo
      await gateway.settled();
      await dispatchService.settled();
    },
    mintToken,
    runModelMethod,
  };
}

export function remoteStepRequest(overrides?: {
  placement?: {
    target?: string;
    labels?: Record<string, string>;
    queueTimeoutMs?: number;
  };
  methodArgs?: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  return {
    placeArguments: (
      args: {
        globalArgs: Record<string, unknown>;
        methodArgs: Record<string, unknown>;
      },
    ) => args,
    placement: overrides?.placement ?? { labels: { tier: "it" } },
    modelDef: modelRegistry.get(IT_TYPE)!,
    modelType: IT_TYPE,
    modelId: IT_DEFINITION_ID,
    methodName: "run",
    definitionName: "remote-it-def",
    definitionTags: {},
    definitionMeta: {
      id: IT_DEFINITION_ID,
      name: "remote-it-def",
      version: 1,
      tags: {},
    },
    globalArgs: {},
    methodArgs: overrides?.methodArgs ?? { echo: "over the wire" },
    workflowName: "it-workflow",
    stepName: "it-step",
    signal: overrides?.signal,
  };
}
