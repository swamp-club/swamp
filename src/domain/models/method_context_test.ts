// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertStrictEquals } from "@std/assert";
import { getLogger } from "@logtape/logtape";

import {
  buildMethodContext,
  type CommonMethodContextDeps,
  type MethodInvocationContext,
} from "./method_context.ts";
import { ModelType } from "./model_type.ts";
import type { DataQueryService } from "../data/data_query_service.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import type { OutputRepository } from "./repositories.ts";
import type { VaultService } from "../vaults/vault_service.ts";
import type { SecretRedactor } from "../secrets/mod.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";

function makeCommon(
  overrides: Partial<CommonMethodContextDeps> = {},
): CommonMethodContextDeps {
  const dataRepository = {} as UnifiedDataRepository;
  const definitionRepository = {} as DefinitionRepository;
  return {
    dataRepository,
    definitionRepository,
    ...overrides,
  };
}

function makeInvocation(
  overrides: Partial<MethodInvocationContext> = {},
): MethodInvocationContext {
  return {
    signal: new AbortController().signal,
    repoDir: "/tmp/test-repo",
    modelType: ModelType.create("test/model"),
    modelId: "model-id-1",
    globalArgs: { foo: "bar" },
    definition: {
      id: "def-1",
      name: "test-model",
      version: 1,
      tags: {},
    },
    methodName: "run",
    logger: getLogger(["test"]),
    ...overrides,
  };
}

Deno.test("buildMethodContext: passes through required common deps", () => {
  const dataRepository = {} as UnifiedDataRepository;
  const definitionRepository = {} as DefinitionRepository;

  const ctx = buildMethodContext(
    { dataRepository, definitionRepository },
    makeInvocation(),
  );

  assertStrictEquals(ctx.dataRepository, dataRepository);
  assertStrictEquals(ctx.definitionRepository, definitionRepository);
});

Deno.test("buildMethodContext: passes through optional common deps", () => {
  const outputRepository = {} as OutputRepository;
  const vaultService = {} as VaultService;
  const redactor = {} as SecretRedactor;
  const dataQueryService = {} as DataQueryService;

  const ctx = buildMethodContext(
    makeCommon({
      outputRepository,
      vaultService,
      redactor,
      dataQueryService,
    }),
    makeInvocation(),
  );

  assertStrictEquals(ctx.outputRepository, outputRepository);
  assertStrictEquals(ctx.vaultService, vaultService);
  assertStrictEquals(ctx.redactor, redactor);
  assertStrictEquals(ctx.dataQueryService, dataQueryService);
});

Deno.test("buildMethodContext: omitted optional common deps flow through as undefined", () => {
  const ctx = buildMethodContext(makeCommon(), makeInvocation());

  assertEquals(ctx.outputRepository, undefined);
  assertEquals(ctx.vaultService, undefined);
  assertEquals(ctx.redactor, undefined);
  assertEquals(ctx.dataQueryService, undefined);
  assertEquals(ctx.cloudControlClientFactory, undefined);
});

Deno.test("buildMethodContext: passes through invocation overlay fields", () => {
  const modelType = ModelType.create("test/model");
  const signal = new AbortController().signal;
  const logger = getLogger(["test"]);
  const onEvent = () => {};

  const ctx = buildMethodContext(
    makeCommon(),
    {
      signal,
      repoDir: "/tmp/foo",
      modelType,
      modelId: "m1",
      globalArgs: { a: 1 },
      definition: { id: "d1", name: "n1", version: 2, tags: { t: "v" } },
      methodName: "go",
      logger,
      runtimeTags: { run: "tag" },
      tagOverrides: { source: "test" },
      dataOutputOverrides: [{ specName: "out" }],
      onEvent,
      skipCheckNames: ["a"],
      skipCheckLabels: ["b"],
      skipAllChecks: true,
      skipReportNames: ["r1"],
      skipReportLabels: ["r2"],
      skipAllReports: false,
      reportNames: ["only"],
      reportLabels: ["label"],
      driver: "raw",
      driverConfig: { k: "v" },
      vaultSecrets: { list: () => [] } as unknown as MethodInvocationContext[
        "vaultSecrets"
      ],
      unresolvedMethodArgs: { arg: "sentinel" },
    },
  );

  assertStrictEquals(ctx.signal, signal);
  assertEquals(ctx.repoDir, "/tmp/foo");
  assertStrictEquals(ctx.modelType, modelType);
  assertEquals(ctx.modelId, "m1");
  assertEquals(ctx.globalArgs, { a: 1 });
  assertEquals(ctx.definition, {
    id: "d1",
    name: "n1",
    version: 2,
    tags: { t: "v" },
  });
  assertEquals(ctx.methodName, "go");
  assertStrictEquals(ctx.logger, logger);
  assertEquals(ctx.runtimeTags, { run: "tag" });
  assertEquals(ctx.tagOverrides, { source: "test" });
  assertEquals(ctx.dataOutputOverrides, [{ specName: "out" }]);
  assertStrictEquals(ctx.onEvent, onEvent);
  assertEquals(ctx.skipCheckNames, ["a"]);
  assertEquals(ctx.skipCheckLabels, ["b"]);
  assertEquals(ctx.skipAllChecks, true);
  assertEquals(ctx.skipReportNames, ["r1"]);
  assertEquals(ctx.skipReportLabels, ["r2"]);
  assertEquals(ctx.skipAllReports, false);
  assertEquals(ctx.reportNames, ["only"]);
  assertEquals(ctx.reportLabels, ["label"]);
  assertEquals(ctx.driver, "raw");
  assertEquals(ctx.driverConfig, { k: "v" });
  assertEquals(ctx.unresolvedMethodArgs, { arg: "sentinel" });
});

Deno.test("buildMethodContext: queryData is not populated by the factory", () => {
  // queryData is derived at the driver boundary from dataQueryService.
  // Factory output has no queryData of its own — the field is left
  // undefined so the driver can bind it consistently.
  const ctx = buildMethodContext(
    makeCommon({ dataQueryService: {} as DataQueryService }),
    makeInvocation(),
  );

  assertEquals(ctx.queryData, undefined);
});
