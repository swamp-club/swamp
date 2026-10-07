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
 * Control-plane records never reach a worker: every capability read and the
 * data-plane artifact read hide them, in any spelling, while user data stays
 * readable and a fleet-probe dispatch still reads its own records
 * (swamp-club#3129). The capability service and data plane run over a real
 * repository and data query service, with grants and groups stored under
 * their `@swamp/...` types as the access commands write them.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Data } from "../src/domain/data/data.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { CapabilityService } from "../src/serve/capability_service.ts";
import { DataPlane } from "../src/serve/data_plane.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import { BundleRegistry } from "../src/serve/bundle_registry.ts";
import type { VaultService } from "../src/domain/vaults/vault_service.ts";
import {
  saveData,
  saveModel,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const GRANT_TYPE = ModelType.create("@swamp/grant");
const GROUP_TYPE = ModelType.create("@swamp/group");
const PROBE_TYPE = ModelType.create("swamp/fleet-probe");

const USER_WORKER = "w-user";
const PROBE_WORKER = "w-probe";

interface Fixtures {
  repo: ServeRepo;
  grantDef: Definition;
  probeDef: Definition;
  capabilities: CapabilityService;
  plane: DataPlane;
}

async function saveControlPlaneRecord(
  repo: ServeRepo,
  type: ModelType,
  name: string,
  dataName: string,
): Promise<Definition> {
  const autoDefinitions = new YamlDefinitionRepository(
    repo.repoDir,
    undefined,
    join(repo.repoDir, ".swamp", "auto-definitions"),
    false,
  );
  const definition = Definition.create({ name, globalArguments: {} });
  await autoDefinitions.save(type, definition);
  const data = Data.create({
    name: dataName,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", modelName: name },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${type.normalized}:${definition.id}`,
    },
  });
  await repo.repoContext.unifiedDataRepo.save(
    type,
    definition.id,
    data,
    new TextEncoder().encode(JSON.stringify({ secret: `${name}-secret` })),
  );
  return definition;
}

function register(
  dispatches: DispatchRegistry,
  workerName: string,
  modelType: ModelType,
  modelId: string,
) {
  dispatches.register({
    workerName,
    dispatchId: `d-${workerName}`,
    leaseId: `l-${workerName}`,
    modelDef: {} as never,
    modelType,
    modelId,
    methodName: "run",
    definitionName: workerName,
    definitionTags: {},
  });
}

async function withFixtures(fn: (f: Fixtures) => Promise<void>) {
  await withServeRepo(async (repo) => {
    const grantDef = await saveControlPlaneRecord(
      repo,
      GRANT_TYPE,
      "shared-name",
      "grant-main",
    );
    await saveControlPlaneRecord(repo, GROUP_TYPE, "ops", "group-main");
    const probeDef = await saveControlPlaneRecord(
      repo,
      PROBE_TYPE,
      "fleet-probe",
      "probe-result",
    );
    const userModel = await saveModel(repo, "shared-name");
    await saveData(repo, userModel, "state");

    const dispatches = new DispatchRegistry();
    register(dispatches, USER_WORKER, repo.modelType, userModel.id);
    register(dispatches, PROBE_WORKER, PROBE_TYPE, probeDef.id);
    const noVault = () =>
      Promise.reject(new Error("no vault")) as Promise<VaultService>;
    const capabilities = new CapabilityService({
      repoDir: repo.repoDir,
      repoContext: repo.repoContext,
      dispatches,
      createVaultService: noVault,
    });
    const plane = new DataPlane({
      repoDir: repo.repoDir,
      repoContext: repo.repoContext,
      sessions: { verify: (credential) => ({ workerId: credential }) },
      dispatches,
      bundles: new BundleRegistry(),
      createVaultService: noVault,
    });
    await fn({ repo, grantDef, probeDef, capabilities, plane });
  });
}

function modelTypes(records: unknown[]): string[] {
  return records.map((record) => (record as { modelType: string }).modelType);
}

async function readArtifact(
  plane: DataPlane,
  workerName: string,
  type: string,
  modelId: string,
  dataName: string,
): Promise<number> {
  const response = await plane.handle(
    new Request(
      `http://dataplane/data/${
        encodeURIComponent(type)
      }/${modelId}/${dataName}/1`,
      { headers: { authorization: `Bearer ${workerName}` } },
    ),
  );
  assert(response, "the data plane handled the read");
  await response.body?.cancel();
  return response.status;
}

Deno.test("worker control plane: a broad query returns user data without control-plane records", async () => {
  await withFixtures(async (f) => {
    // Precondition: run directly, the query does match control-plane
    // records, under their stored @swamp/... types.
    const direct = modelTypes(
      await f.repo.repoContext.dataQueryService.query("true"),
    );
    assert(direct.includes("@swamp/grant"), direct.join(", "));
    assert(direct.includes("@swamp/group"), direct.join(", "));
    const records = await f.capabilities.queryData(USER_WORKER, {
      predicate: "true",
    });
    const types = modelTypes(records);
    assert(types.includes(f.repo.modelType.normalized), types.join(", "));
    for (const type of types) {
      assert(!type.includes("swamp/"), `leaked ${type}`);
    }
  });
});

Deno.test("worker control plane: a query naming a control-plane type returns nothing", async () => {
  await withFixtures(async (f) => {
    for (
      const predicate of [
        'modelType == "@swamp/grant"',
        'modelType == "swamp/grant"',
        'modelType == "@swamp/group"',
        'modelType == "swamp/fleet-probe"',
      ]
    ) {
      assertEquals(
        await f.capabilities.queryData(USER_WORKER, { predicate }),
        [],
        predicate,
      );
    }
  });
});

Deno.test("worker control plane: definition, output, version and model reads hide control-plane records", async () => {
  await withFixtures(async (f) => {
    assertEquals(
      await f.capabilities.readDefinition(USER_WORKER, {
        definitionType: "@swamp/grant",
        idOrName: "shared-name",
      }),
      { found: false, definition: null },
    );
    assertEquals(
      await f.capabilities.readOutput(USER_WORKER, {
        modelType: "@swamp/grant",
      }),
      { result: [] },
    );
    assertEquals(
      await f.capabilities.listVersions(USER_WORKER, {
        modelType: "@swamp/grant",
        modelId: f.grantDef.id,
        dataName: "grant-main",
      }),
      [],
    );
    // A grant and the user model share a name: the worker resolves the
    // user model, never the grant, by name or by the grant's id.
    const byName = await f.capabilities.resolveModel(USER_WORKER, {
      modelIdOrName: "shared-name",
    }) as { found: boolean; modelType?: string };
    assertEquals(byName.found, true);
    assertEquals(byName.modelType, f.repo.modelType.normalized);
    assertEquals(
      await f.capabilities.resolveModel(USER_WORKER, {
        modelIdOrName: f.grantDef.id,
      }),
      { found: false },
    );
  });
});

Deno.test("worker control plane: the data plane serves no control-plane bytes", async () => {
  await withFixtures(async (f) => {
    for (const type of ["@swamp/grant", "swamp/grant", "@@swamp/grant"]) {
      assertEquals(
        await readArtifact(
          f.plane,
          USER_WORKER,
          type,
          f.grantDef.id,
          "grant-main",
        ),
        404,
        type,
      );
    }
  });
});

Deno.test("worker control plane: a fleet-probe dispatch reads its own records and nothing else", async () => {
  await withFixtures(async (f) => {
    const own = await f.capabilities.queryData(PROBE_WORKER, {
      predicate: 'modelType == "swamp/fleet-probe"',
    });
    assertEquals(modelTypes(own), ["swamp/fleet-probe"]);
    assertEquals(
      await readArtifact(
        f.plane,
        PROBE_WORKER,
        "swamp/fleet-probe",
        f.probeDef.id,
        "probe-result",
      ),
      200,
    );
    assertEquals(
      await readArtifact(
        f.plane,
        PROBE_WORKER,
        "@swamp/grant",
        f.grantDef.id,
        "grant-main",
      ),
      404,
    );
    // Another worker cannot read the probe's records.
    assertEquals(
      await f.capabilities.queryData(USER_WORKER, {
        predicate: 'modelType == "swamp/fleet-probe"',
      }),
      [],
    );
  });
});
