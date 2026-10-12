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
 * Remote execution on a v3 datastore (swamp-club#3279): the worker gateway's
 * enrollment and status writes, the capability verbs and the data plane's
 * writes, against an orchestrator built over a v3 repository context as
 * serve builds it, with a real worker over a real socket. Every write must
 * reach the commit log: a second checkout that catches up holds the same
 * records.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { consumeStream, withDefaults } from "../src/libswamp/stream.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createVaultCreateDeps,
  vaultCreate,
} from "../src/libswamp/vaults/create.ts";
import { createWorkerModelRunDeps } from "../src/libswamp/worker/run_deps.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { CapabilityService } from "../src/serve/capability_service.ts";
import { WorkerGateway } from "../src/serve/worker_gateway.ts";
import { DispatchService } from "../src/serve/dispatch_service.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import { BundleRegistry } from "../src/serve/bundle_registry.ts";
import { DataPlane } from "../src/serve/data_plane.ts";
import { runWorker, type WorkerExitResult } from "../src/worker/connect.ts";
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  tokenSecretKey,
} from "../src/domain/models/worker/enrollment_token_model.ts";
import { sweepStaleRecords } from "../src/serve/boot_reconciliation.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { IT_DEFINITION_ID, IT_TYPE } from "./remote_execution_test_model.ts";
import type { RowRepos } from "./usecase_sync_fixtures.ts";
import { assertCheckoutsAgree, withV3RowRepos } from "./usecase_v3_fixtures.ts";

await initializeLogging({});

const MODULE_DIR = dirname(fromFileUrl(import.meta.url));
const RUNNER_ENTRY = join(
  MODULE_DIR,
  "test_fixtures",
  "remote_it_runner_entry.ts",
);
const TEST_RUNNER_COMMAND = {
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

/** Runs a worker-model method, in a root over A's context as v3 needs. */
async function runModelMethod(
  repos: RowRepos,
  input: {
    typeArg: string;
    definitionName: string;
    methodName: string;
    inputs: Record<string, unknown>;
  },
): Promise<void> {
  const deps = await createWorkerModelRunDeps(
    repos.repoA,
    repos.a.repoContext,
  );
  await runInRootUnitOfWork(
    repos.a.repoContext,
    { flush: undefined },
    async () => {
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
    },
  );
}

Deno.test({
  name:
    "v3 remote execution: enrollment, the capability verbs and data-plane writes all commit",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      const repoDir = repos.repoA;
      const repoContext = repos.a.repoContext;
      const libCtx = createLibSwampContext({});
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

      // The orchestrator assembly serve builds.
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
        onWorkerEnrolled: (worker) =>
          dispatchService.notifyWorkerEnrolled(worker),
      });
      dispatchService.bindGateway(gateway);
      const dataPlane = new DataPlane({
        repoDir,
        repoContext,
        sessions: gateway.sessions,
        dispatches,
        bundles,
        onFirstWrite: (dispatch) => dispatchService.recordFirstWrite(dispatch),
      });
      dispatchService.setOnDispatchEnd((id) => dataPlane.releaseDispatch(id));
      await sweepStaleRecords({ repoContext });

      const server = Deno.serve(
        { port: 0, hostname: "127.0.0.1", onListen: () => {} },
        async (req) => {
          const upgrade = req.headers.get("upgrade") ?? "";
          if (upgrade.toLowerCase() === "websocket") {
            const { socket, response } = Deno.upgradeWebSocket(req);
            const attachment = gateway.attachTransport({
              send: (data) => {
                if (socket.readyState === WebSocket.OPEN) socket.send(data);
              },
            });
            socket.onmessage = (event) => {
              if (typeof event.data === "string") attachment.feed(event.data);
            };
            socket.onclose = () => attachment.closed();
            return response;
          }
          return await dataPlane.handle(req) ??
            new Response("Not found", { status: 404 });
        },
      );
      const workerStop = new AbortController();
      let workerDone: Promise<WorkerExitResult> | null = null;
      try {
        await runModelMethod(repos, {
          typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
          definitionName: "it-worker",
          methodName: "mint",
          inputs: { durationMs: 10 * 60 * 1000, vaultName: "local" },
        });
        const vault = await VaultService.fromRepository(repoDir);
        const token = `it-worker.${await vault.get(
          "local",
          tokenSecretKey("it-worker"),
        )}`;

        workerDone = runWorker({
          url: `ws://127.0.0.1:${server.addr.port}`,
          token,
          labels: { tier: "it" },
          swampVersion: "test",
          cacheDir: join(repos.repoA, "..", "worker-cache"),
          signal: workerStop.signal,
          runnerCommand: TEST_RUNNER_COMMAND,
        });
        await waitFor(
          () => gateway.workers().length === 1,
          "worker enrollment",
          { timeoutMs: 30_000 },
        );

        // A dispatch runs inside the run that asked for it, so in that
        // run's root, as the step executor runs it.
        const result = await runInRootUnitOfWork(
          repoContext,
          { flush: undefined },
          () =>
            dispatchService.executeRemote({
              placement: { labels: { tier: "it" } },
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
              methodArgs: { echo: "over the wire" },
              workflowName: "it-workflow",
              stepName: "it-step",
            }),
        );
        assertEquals(
          result.outputs.map((o) => o.specName).sort(),
          ["log", "result"],
        );
        const content = await repoContext.unifiedDataRepo.getContent(
          IT_TYPE,
          IT_DEFINITION_ID,
          "result-main",
        );
        assertEquals(
          JSON.parse(new TextDecoder().decode(content!)).echo,
          "over the wire",
        );
      } finally {
        workerStop.abort();
        if (workerDone) await workerDone.catch(() => {});
        await server.shutdown();
      }
      // The worker's disconnect saves its state in a root that may still be
      // committing after the server stops: wait for the checkouts to agree,
      // then check once more for the assertion's own message.
      await waitFor(
        () =>
          assertCheckoutsAgree(repos, datastorePath, "remote execution").then(
            () => true,
            () => false,
          ),
        "the second checkout to catch up with the worker's last writes",
      );
      assert(
        await assertCheckoutsAgree(repos, datastorePath, "remote execution") >
          0,
      );
    });
  },
});
