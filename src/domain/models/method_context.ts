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

// Production MethodContext construction must go through buildMethodContext.
// Test fixtures may construct MethodContext inline so each test declares
// exactly what it exercises. See method_context_arch_test.ts for enforcement.

import type { MethodContext } from "./model.ts";

/**
 * Startup-scoped dependencies shared across every method invocation in a
 * single execution context. A host (CLI, server, workflow runner) constructs
 * these once and feeds them to `buildMethodContext` for each method call.
 *
 * Field types are reused from MethodContext via indexed access so this file
 * does not add any new infrastructure imports to the domain layer.
 */
export interface CommonMethodContextDeps {
  dataRepository: MethodContext["dataRepository"];
  definitionRepository: MethodContext["definitionRepository"];
  outputRepository?: MethodContext["outputRepository"];
  vaultService?: MethodContext["vaultService"];
  redactor?: MethodContext["redactor"];
  dataQueryService?: MethodContext["dataQueryService"];
  cloudControlClientFactory?: MethodContext["cloudControlClientFactory"];
}

/**
 * Per-invocation overlay describing the model and method being executed.
 * Populated fresh for each call into `buildMethodContext`.
 */
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
  driver?: MethodContext["driver"];
  driverConfig?: MethodContext["driverConfig"];
  vaultSecrets?: MethodContext["vaultSecrets"];
  unresolvedMethodArgs?: MethodContext["unresolvedMethodArgs"];
}

/**
 * Assembles a `MethodContext` from startup-scoped dependencies and
 * per-invocation overlay. This is the single production entry point for
 * MethodContext construction — every method execution path (manual runs,
 * workflow steps, pre-flight check validation) routes through here.
 *
 * `queryData` is intentionally not an input. The RawExecutionDriver derives
 * it from `dataQueryService` at execution time, with a fallback for test
 * fixtures that set `queryData` directly.
 */
export function buildMethodContext(
  common: CommonMethodContextDeps,
  invocation: MethodInvocationContext,
): MethodContext {
  return {
    signal: invocation.signal,
    repoDir: invocation.repoDir,
    modelType: invocation.modelType,
    modelId: invocation.modelId,
    globalArgs: invocation.globalArgs,
    definition: invocation.definition,
    methodName: invocation.methodName,
    logger: invocation.logger,
    dataRepository: common.dataRepository,
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
    driver: invocation.driver,
    driverConfig: invocation.driverConfig,
    vaultSecrets: invocation.vaultSecrets,
    unresolvedMethodArgs: invocation.unresolvedMethodArgs,
  };
}
