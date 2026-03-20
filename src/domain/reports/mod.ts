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

export type { ReportDefinition, ReportResult, ReportScope } from "./report.ts";
export type {
  MethodReportContext,
  ModelReportContext,
  ReportContext,
  WorkflowReportContext,
} from "./report_context.ts";
export { ReportRegistry, reportRegistry } from "./report_registry.ts";
export {
  type ReportRef,
  type ReportSelection,
  ReportSelectionSchema,
} from "./report_selection.ts";
export {
  executeReports,
  filterReports,
  type ReportEventCallback,
  type ReportExecutionResult,
  type ReportExecutionSummary,
  type ReportFilterOptions,
} from "./report_execution_service.ts";
export { buildReportDataHandles } from "./report_data_handles.ts";
