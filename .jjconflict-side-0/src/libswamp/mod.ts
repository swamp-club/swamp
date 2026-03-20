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

export { createLibSwampContext, type LibSwampContext } from "./context.ts";
export {
  alreadyExists,
  cancelled,
  invalidApiKey,
  notAuthenticated,
  notFound,
  type SwampError,
  validationFailed,
} from "./errors.ts";
export {
  consumeStream,
  type EventHandlers,
  type HasTerminals,
  result,
  type StreamEvent,
  withDefaults,
} from "./stream.ts";
export { AsyncQueue } from "./stream/async_queue.ts";
export { merge } from "./stream/merge.ts";
export { assertCompletes, assertErrors, collect } from "./testing.ts";

// Auth operations
export {
  type AuthDeps,
  type AuthWhoamiEvent,
  createAuthDeps,
  whoami,
  type WhoamiIdentity,
} from "./auth/whoami.ts";

// Workflow operations
export {
  extractStepArtifacts,
  inputValidationFailed,
  toRunData,
  workflowExecutionFailed,
  workflowNotFound,
  workflowRun,
  type WorkflowRunDeps,
  type WorkflowRunEvent,
  type WorkflowRunInput,
} from "./workflows/run.ts";
export type { MethodExecutionEvent } from "../domain/models/method_events.ts";
export {
  type DataArtifactRefData,
  type JobRunView,
  type StepArtifactsData,
  type StepRunView,
  type WorkflowRunView,
} from "./workflows/workflow_run_view.ts";

// Model operations
export {
  type EnvVarUsage,
  methodExecutionFailed,
  modelMethodRun,
  type ModelMethodRunDeps,
  type ModelMethodRunEvent,
  type ModelMethodRunInput,
  modelNotFound,
  noEvaluatedDefinition,
  type RunLog,
  unknownMethod,
  unknownModelType,
} from "./models/run.ts";
export {
  type DataArtifactView,
  type ModelMethodRunView,
  type ModelReportView,
  type ReportResultView,
} from "./models/model_method_run_view.ts";

// Report operations (top-level)
export { reportDescribe, type ReportDescribeDeps } from "./reports/describe.ts";
export {
  reportSearch,
  type ReportSearchDeps,
  type ReportSearchInput,
} from "./reports/search.ts";
export {
  reportGet,
  type ReportGetDeps,
  type ReportGetInput,
} from "./reports/get.ts";
export type {
  ReportDefinitionDetail,
  ReportDescribeEvent,
  ReportGetEvent,
  ReportSearchEvent,
  StoredReportDetail,
  StoredReportSummary,
} from "./reports/report_views.ts";
export {
  createModelGetDeps,
  modelGet,
  type ModelGetData,
  type ModelGetDeps,
  type ModelGetEvent,
} from "./models/get.ts";
export {
  type ArtifactsData,
  createModelOutputGetDeps,
  type ErrorData,
  type GlobalOutputInfo,
  modelOutputGet,
  type ModelOutputGetData,
  type ModelOutputGetDeps,
  type ModelOutputGetEvent,
  type OutputInfo,
  type ProvenanceData,
} from "./models/output_get.ts";
export {
  createModelMethodDescribeDeps,
  modelMethodDescribe,
  type ModelMethodDescribeData,
  type ModelMethodDescribeDeps,
  type ModelMethodDescribeEvent,
} from "./models/method_describe.ts";

// Workflow get operations
export {
  createWorkflowGetDeps,
  isUuid,
  workflowGet,
  type WorkflowGetData,
  type WorkflowGetDeps,
  type WorkflowGetEvent,
} from "./workflows/get.ts";
export {
  createWorkflowHistoryGetDeps,
  workflowHistoryGet,
  type WorkflowHistoryGetDeps,
  type WorkflowHistoryGetEvent,
} from "./workflows/history_get.ts";

// Vault operations
export {
  createVaultGetDeps,
  type VaultConfigInfo,
  vaultGet,
  type VaultGetData,
  type VaultGetDeps,
  type VaultGetEvent,
} from "./vaults/get.ts";
export {
  createVaultDescribeDeps,
  vaultDescribe,
  type VaultDescribeData,
  type VaultDescribeDeps,
  type VaultDescribeEvent,
} from "./vaults/describe.ts";

// Data operations
export {
  createDataGetDeps,
  dataGet,
  type DataGetData,
  type DataGetDeps,
  type DataGetEvent,
  type DataGetInput,
} from "./data/get.ts";
export {
  createDataVersionsDeps,
  type DataVersionInfo,
  dataVersions,
  type DataVersionsData,
  type DataVersionsDeps,
  type DataVersionsEvent,
  type DataVersionsInput,
} from "./data/versions.ts";
export {
  createDataListDeps,
  type DataGroupedByType,
  dataList,
  type DataListData,
  type DataListDeps,
  type DataListEvent,
  type DataListInput,
  type DataListItem,
  type WorkflowDataListData,
  type WorkflowDataListItem,
} from "./data/list.ts";

// Extension trust operations
export {
  DEFAULT_TRUSTED,
  resolveTrustedCollectives,
  type TrustModifyData,
  type TrustModifyEvent,
} from "./extensions/trust.ts";
export {
  createTrustListDeps,
  trustList,
  type TrustListData,
  type TrustListDeps,
  type TrustListEvent,
} from "./extensions/trust_list.ts";
export {
  createTrustAddDeps,
  trustAdd,
  type TrustAddDeps,
} from "./extensions/trust_add.ts";
export {
  createTrustRmDeps,
  trustRm,
  type TrustRmDeps,
} from "./extensions/trust_rm.ts";
export {
  createTrustAutoTrustDeps,
  trustAutoTrust,
  type TrustAutoTrustData,
  type TrustAutoTrustDeps,
  type TrustAutoTrustEvent,
} from "./extensions/trust_auto_trust.ts";

// Type operations
export {
  createTypeDescribeDeps,
  typeDescribe,
  type TypeDescribeData,
  type TypeDescribeDeps,
  type TypeDescribeEvent,
} from "./types/describe.ts";
export {
  type DataOutputSpecDescribeData,
  type MethodDescribeData,
  toMethodDescribeData,
  zodToJsonSchema,
} from "./types/schema_helpers.ts";

// Workflow schema operations
export {
  workflowSchema,
  type WorkflowSchemaData,
  type WorkflowSchemaEvent,
} from "./workflows/schema.ts";

// Workflow validate operations
export {
  createWorkflowValidateDeps,
  isWorkflowValidateAllData,
  type ValidationItemData as WorkflowValidationItemData,
  workflowValidate,
  type WorkflowValidateAllData,
  type WorkflowValidateData,
  type WorkflowValidateDeps,
  type WorkflowValidateEvent,
  type WorkflowValidateInput,
} from "./workflows/validate.ts";

// Workflow history logs operations
export {
  createWorkflowHistoryLogsDeps,
  workflowHistoryLogs,
  type WorkflowHistoryLogsDeps,
  type WorkflowHistoryLogsEvent,
  type WorkflowHistoryLogsInput,
} from "./workflows/history_logs.ts";

// Model validate operations
export {
  createModelValidateDeps,
  isModelValidateAllData,
  modelValidate,
  type ModelValidateAllData,
  type ModelValidateData,
  type ModelValidateDeps,
  type ModelValidateEvent,
  type ModelValidateInput,
  type ValidationItemData as ModelValidationItemData,
  type ValidationWarningData as ModelValidationWarningData,
} from "./models/validate.ts";

// Model method history logs operations
export {
  createModelMethodHistoryLogsDeps,
  modelMethodHistoryLogs,
  type ModelMethodHistoryLogsDeps,
  type ModelMethodHistoryLogsEvent,
  type ModelMethodHistoryLogsInput,
} from "./models/method_history_logs.ts";

// Model output logs operations
export {
  createModelOutputLogsDeps,
  modelOutputLogs,
  type ModelOutputLogsDeps,
  type ModelOutputLogsEvent,
  type ModelOutputLogsInput,
} from "./models/output_logs.ts";

// Model output data operations
export {
  createModelOutputDataDeps,
  modelOutputData,
  type ModelOutputDataDeps,
  type ModelOutputDataEvent,
  type ModelOutputDataInput,
} from "./models/output_data.ts";

// Vault list-keys operations
export {
  createVaultListKeysDeps,
  vaultListKeys,
  type VaultListKeysData,
  type VaultListKeysDeps,
  type VaultListKeysEvent,
  type VaultListKeysInput,
} from "./vaults/list_keys.ts";

// Extension operations
export {
  createExtensionListDeps,
  extensionList,
  type ExtensionListData,
  type ExtensionListDeps,
  type ExtensionListEntry,
  type ExtensionListEvent,
} from "./extensions/list.ts";

// Telemetry operations
export {
  createTelemetryStatsDeps,
  telemetryStats,
  type TelemetryStatsData,
  type TelemetryStatsDeps,
  type TelemetryStatsEvent,
  type TelemetryStatsInput,
} from "./telemetry/stats.ts";
