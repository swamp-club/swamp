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

// Production MethodContext construction must go through buildMethodContext.
// Test fixtures may construct MethodContext inline so each test declares
// exactly what it exercises. See method_context_arch_test.ts for enforcement.

import type { MethodContext } from "./model.ts";
import { resolveExtensionFile } from "../extensions/extension_file_resolver.ts";
import { isUuid } from "./model_lookup.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import type { ModelTypeInput } from "./model_type.ts";

/**
 * field types are reused from MethodContext via indexed access so this file
 * adds no infrastructure imports to the domain layer
 */
export interface CommonMethodContextDeps {
  dataRepository: MethodContext["dataRepository"];
  definitionRepository: MethodContext["definitionRepository"];
  outputRepository?: MethodContext["outputRepository"];
  vaultService?: MethodContext["vaultService"];
  redactor?: MethodContext["redactor"];
  dataQueryService?: MethodContext["dataQueryService"];
  cloudControlClientFactory?: MethodContext["cloudControlClientFactory"];
  /**
   * passed in by the application layer so the domain layer does not import the
   * cel-js binding directly
   */
  createCelEnvironment: MethodContext["createCelEnvironment"];
}

export interface MethodInvocationContext {
  signal: MethodContext["signal"];
  repoDir: MethodContext["repoDir"];
  modelType: MethodContext["modelType"];
  modelId: MethodContext["modelId"];
  globalArgs: MethodContext["globalArgs"];
  definition: MethodContext["definition"];
  methodName: MethodContext["methodName"];
  logger: MethodContext["logger"];
  runtimeTags?: MethodContext["runtimeTags"];
  tagOverrides?: MethodContext["tagOverrides"];
  dataOutputOverrides?: MethodContext["dataOutputOverrides"];
  onEvent?: MethodContext["onEvent"];
  skipCheckNames?: MethodContext["skipCheckNames"];
  skipCheckLabels?: MethodContext["skipCheckLabels"];
  skipAllChecks?: MethodContext["skipAllChecks"];
  skipReportNames?: MethodContext["skipReportNames"];
  skipReportLabels?: MethodContext["skipReportLabels"];
  skipAllReports?: MethodContext["skipAllReports"];
  reportNames?: MethodContext["reportNames"];
  reportLabels?: MethodContext["reportLabels"];
  placement?: MethodContext["placement"];
  declaredWrites?: MethodContext["declaredWrites"];
  inFlightDataWrites?: MethodContext["inFlightDataWrites"];
  vaultSecrets?: MethodContext["vaultSecrets"];
  unresolvedMethodArgs?: MethodContext["unresolvedMethodArgs"];
  /**
   * Extension-files root for `ctx.extensionFile()`. Read from
   * `ModelDefinition.extensionFilesRoot` at each call site. Undefined for
   * built-in model types and for source-loaded dirs without a manifest.
   */
  extensionFilesRoot?: string;
}

/**
 * queryData is intentionally not an input: InProcessExecutor derives it from
 * dataQueryService at execution time, with a fallback for test fixtures that
 * set it directly
 */
export function buildMethodContext(
  common: CommonMethodContextDeps,
  invocation: MethodInvocationContext,
): MethodContext {
  const root = invocation.extensionFilesRoot;
  return {
    signal: invocation.signal,
    repoDir: invocation.repoDir,
    modelType: invocation.modelType,
    modelId: invocation.modelId,
    globalArgs: invocation.globalArgs,
    definition: invocation.definition,
    methodName: invocation.methodName,
    logger: invocation.logger,
    dataRepository: withNameResolution(
      common.dataRepository,
      common.definitionRepository,
    ),
    definitionRepository: common.definitionRepository,
    outputRepository: common.outputRepository,
    vaultService: common.vaultService,
    redactor: common.redactor,
    dataQueryService: common.dataQueryService,
    cloudControlClientFactory: common.cloudControlClientFactory,
    runtimeTags: invocation.runtimeTags,
    tagOverrides: invocation.tagOverrides,
    dataOutputOverrides: invocation.dataOutputOverrides,
    onEvent: invocation.onEvent,
    skipCheckNames: invocation.skipCheckNames,
    skipCheckLabels: invocation.skipCheckLabels,
    skipAllChecks: invocation.skipAllChecks,
    skipReportNames: invocation.skipReportNames,
    skipReportLabels: invocation.skipReportLabels,
    skipAllReports: invocation.skipAllReports,
    reportNames: invocation.reportNames,
    reportLabels: invocation.reportLabels,
    placement: invocation.placement,
    declaredWrites: invocation.declaredWrites,
    inFlightDataWrites: invocation.inFlightDataWrites,
    vaultSecrets: invocation.vaultSecrets,
    unresolvedMethodArgs: invocation.unresolvedMethodArgs,
    extensionFile: (relPath: string) => resolveExtensionFile(root, relPath),
    createCelEnvironment: common.createCelEnvironment,
  };
}

async function resolveModelId(
  definitionRepo: DefinitionRepository,
  modelId: string,
): Promise<string> {
  if (isUuid(modelId)) return modelId;
  const result = await definitionRepo.findByNameGlobal(modelId);
  if (result) return result.definition.id;
  return modelId;
}

function withNameResolution(
  repo: UnifiedDataRepository,
  definitionRepo: DefinitionRepository,
): UnifiedDataRepository {
  return Object.create(repo, {
    findAllForModel: {
      value: async (type: ModelTypeInput, modelId: string) => {
        const resolved = await resolveModelId(definitionRepo, modelId);
        return repo.findAllForModel(type, resolved);
      },
    },
    iterateForModel: {
      value: async function* (type: ModelTypeInput, modelId: string) {
        const resolved = await resolveModelId(definitionRepo, modelId);
        yield* repo.iterateForModel(type, resolved);
      },
    },
    getContent: {
      value: async (
        type: ModelTypeInput,
        modelId: string,
        dataName: string,
        version?: number,
      ) => {
        const resolved = await resolveModelId(definitionRepo, modelId);
        return repo.getContent(type, resolved, dataName, version);
      },
    },
  });
}
