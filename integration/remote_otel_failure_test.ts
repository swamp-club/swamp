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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { propagation } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { z } from "zod";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { VaultService } from "../src/domain/vaults/vault_service.ts";
import { observeExecution } from "../src/domain/remote/observability.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { InMemoryUnifiedDataRepository } from "../src/infrastructure/persistence/in_memory_data_repository.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  installExecutionObserver,
  uninstallExecutionObserver,
} from "../src/infrastructure/tracing/execution_observer.ts";
import {
  findSpan,
  isChildOf,
  withCapturedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";
import { DataPlane } from "../src/serve/data_plane.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import { BundleRegistry } from "../src/serve/bundle_registry.ts";
import { DataPlaneClient } from "../src/worker/data_plane_client.ts";

await initializeLogging({});

Deno.test("remote telemetry: commit followed by lost response preserves write and reports unknown caller knowledge without retry", async () => {
  const dir = await Deno.makeTempDir();
  const catalog = new CatalogStore(":memory:");
  const repo = new InMemoryUnifiedDataRepository(catalog);
  try {
    await withCapturedSpans(async (spans) => {
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
      installExecutionObserver();
      const dispatch = observeExecution("dispatch.send");
      const dispatches = new DispatchRegistry();
      const type = ModelType.create("test/otel-write");
      dispatches.register({
        workerName: "worker",
        dispatchId: "dispatch",
        leaseId: "lease",
        modelType: type,
        modelId: "model",
        methodName: "run",
        definitionName: "write",
        definitionTags: {},
        traceHeaders: dispatch.carrier ? { ...dispatch.carrier } : undefined,
        modelDef: {
          type,
          version: "1.0.0",
          methods: {},
          resources: {
            result: {
              description: "Test result",
              schema: z.object({ value: z.string() }),
              lifetime: "infinite",
              garbageCollection: 5,
            },
          },
        },
      });
      const plane = new DataPlane({
        repoDir: dir,
        repoContext: { unifiedDataRepo: repo } as unknown as RepositoryContext,
        sessions: {
          verify: (credential) =>
            credential === "credential" ? { workerId: "worker" } : null,
        },
        dispatches,
        bundles: new BundleRegistry(),
        onFirstWrite: () => Promise.resolve(),
        createVaultService: () => Promise.resolve({} as VaultService),
      });
      const lost = new Error("response interrupted after persistence");
      let requests = 0;
      const client = new DataPlaneClient({
        baseUrl: "http://serve.test",
        credential: () => "credential",
        fetchImpl: async (input, init) => {
          requests++;
          const response = await plane.handle(new Request(input, init));
          assert(response?.ok);
          await response.body?.cancel();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(lost);
              },
            }),
          );
        },
      });
      try {
        const error = await assertRejects(() =>
          dispatch.run(() =>
            client.writeResource({
              specName: "result",
              name: "result",
              data: { value: "saved" },
            })
          )
        );
        assertEquals(error, lost);
        assertEquals(requests, 1);
        const saved = await repo.findByName(type, "model", "result");
        assert(saved);
        assertEquals(saved.version, 1);
        const persistence = findSpan(spans, "swamp.serve.data_plane.persist");
        assertEquals(persistence.attributes["swamp.commit.state"], "committed");
        const caller = findSpan(spans, "swamp.data.client");
        assertEquals(caller.attributes["swamp.commit.state"], "unknown");
        assertEquals(caller.attributes["swamp.outcome"], "error");
        assertEquals(caller.attributes["swamp.reconciliation"], "unsupported");
        assert(isChildOf(findSpan(spans, "swamp.serve.data_plane"), caller));
      } finally {
        dispatch.end("error");
        uninstallExecutionObserver();
        propagation.disable();
      }
    });
  } finally {
    repo.dispose();
    catalog.close();
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});
