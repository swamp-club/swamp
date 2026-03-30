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

/**
 * Type compatibility test for @systeminit/swamp-testing report types.
 *
 * Verifies that the testing package's report types remain structurally
 * compatible with swamp's canonical types. The testing package uses
 * simplified repository interfaces (TestDataRepository, TestDefinitionRepository)
 * so we verify scope-discriminated fields and ReportResult rather than
 * full context assignability.
 */

import type {
  ReportResult as CanonicalReportResult,
  ReportScope as CanonicalReportScope,
} from "./report.ts";
import type {
  MethodReportContext as CanonicalMethodReportContext,
  WorkflowReportContext as CanonicalWorkflowReportContext,
} from "./report_context.ts";

import type {
  MethodReportContext as TestingMethodReportContext,
  ReportResult as TestingReportResult,
  ReportScope as TestingReportScope,
  WorkflowReportContext as TestingWorkflowReportContext,
} from "../../../packages/testing/report_types.ts";

// ReportResult: verify fields match.
function _checkReportResultFields(result: TestingReportResult) {
  const _markdown: CanonicalReportResult["markdown"] = result.markdown;
  const _json: CanonicalReportResult["json"] = result.json;
  void [_markdown, _json];
}

// ReportScope: verify the testing type's values match canonical.
function _checkReportScope(scope: TestingReportScope) {
  const _canonical: CanonicalReportScope = scope;
  void _canonical;
}

// MethodReportContext: verify scope-specific fields match canonical.
function _checkMethodReportContextFields(ctx: TestingMethodReportContext) {
  const _scope: CanonicalMethodReportContext["scope"] = ctx.scope;
  const _modelId: CanonicalMethodReportContext["modelId"] = ctx.modelId;
  const _methodName: CanonicalMethodReportContext["methodName"] =
    ctx.methodName;
  const _executionStatus: CanonicalMethodReportContext["executionStatus"] =
    ctx.executionStatus;
  const _errorMessage: CanonicalMethodReportContext["errorMessage"] =
    ctx.errorMessage;
  const _globalArgs: CanonicalMethodReportContext["globalArgs"] =
    ctx.globalArgs;
  const _methodArgs: CanonicalMethodReportContext["methodArgs"] =
    ctx.methodArgs;
  const _repoDir: string = ctx.repoDir;

  // definition sub-fields
  const _defId: string = ctx.definition.id;
  const _defName: string = ctx.definition.name;
  const _defVersion: number = ctx.definition.version;
  const _defTags: Record<string, string> = ctx.definition.tags;

  void [
    _scope,
    _modelId,
    _methodName,
    _executionStatus,
    _errorMessage,
    _globalArgs,
    _methodArgs,
    _repoDir,
    _defId,
    _defName,
    _defVersion,
    _defTags,
  ];
}

// WorkflowReportContext: verify scope-specific fields match canonical.
function _checkWorkflowReportContextFields(ctx: TestingWorkflowReportContext) {
  const _scope: CanonicalWorkflowReportContext["scope"] = ctx.scope;
  const _workflowId: CanonicalWorkflowReportContext["workflowId"] =
    ctx.workflowId;
  const _workflowRunId: CanonicalWorkflowReportContext["workflowRunId"] =
    ctx.workflowRunId;
  const _workflowName: CanonicalWorkflowReportContext["workflowName"] =
    ctx.workflowName;
  const _workflowStatus: CanonicalWorkflowReportContext["workflowStatus"] =
    ctx.workflowStatus;

  // stepExecutions sub-fields
  if (ctx.stepExecutions.length > 0) {
    const step = ctx.stepExecutions[0];
    const _jobName: string = step.jobName;
    const _stepName: string = step.stepName;
    const _modelName: string = step.modelName;
    const _modelType: string = step.modelType;
    const _methodName: string = step.methodName;
    const _status: "succeeded" | "failed" | "skipped" = step.status;
    const _methodArgs: Record<string, unknown> = step.methodArgs;
    const _modelId: string = step.modelId;
    const _globalArgs: Record<string, unknown> = step.globalArgs;
    void [
      _jobName,
      _stepName,
      _modelName,
      _modelType,
      _methodName,
      _status,
      _methodArgs,
      _modelId,
      _globalArgs,
    ];
  }

  void [_scope, _workflowId, _workflowRunId, _workflowName, _workflowStatus];
}

Deno.test("testing package report types: compile-time compatibility check", () => {
  void [
    _checkReportResultFields,
    _checkReportScope,
    _checkMethodReportContextFields,
    _checkWorkflowReportContextFields,
  ];
});
