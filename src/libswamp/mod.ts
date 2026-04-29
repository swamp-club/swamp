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
  type WorkflowRunJobInfo,
} from "./workflows/run.ts";
export type { MethodExecutionEvent } from "../domain/models/method_events.ts";
export {
  type DataArtifactRefData,
  type JobRunView,
  type StepArtifactsData,
  type StepRunView,
  type WorkflowRunView,
} from "./workflows/workflow_run_view.ts";

// Scheduled execution
export {
  type ScheduledExecutionDeps,
  type ScheduledExecutionEvent,
  type ScheduledExecutionEventHandler,
  ScheduledExecutionService,
  type WorkflowExecutor,
} from "./workflows/scheduled_execution.ts";
export { workflowsDir, WorkflowWatcher } from "./workflows/watcher.ts";
export {
  type ScheduleEntry,
  type ScheduleFireCallback,
  WorkflowScheduler,
} from "../domain/workflows/workflow_scheduler.ts";

// Workflow search operations
export {
  workflowSearch,
  type WorkflowSearchData,
  type WorkflowSearchDeps,
  type WorkflowSearchEvent,
  type WorkflowSearchInput,
  type WorkflowSearchItem,
} from "./workflows/search.ts";
export {
  workflowRunSearch,
  type WorkflowRunSearchData,
  type WorkflowRunSearchDeps,
  type WorkflowRunSearchEvent,
  type WorkflowRunSearchInput,
  type WorkflowRunSearchItem,
} from "./workflows/run_search.ts";
export {
  workflowHistorySearch,
  type WorkflowHistorySearchData,
  type WorkflowHistorySearchDeps,
  type WorkflowHistorySearchEvent,
  type WorkflowHistorySearchInput,
  type WorkflowHistorySearchItem,
} from "./workflows/history_search.ts";

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
export {
  createReportDescribeDeps,
  reportDescribe,
  type ReportDescribeDeps,
} from "./reports/describe.ts";
export {
  createReportSearchDeps,
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
  modelSearch,
  type ModelSearchData,
  type ModelSearchDeps,
  type ModelSearchEvent,
  type ModelSearchInput,
  type ModelSearchItem,
} from "./models/search.ts";
export {
  modelOutputSearch,
  type ModelOutputSearchData,
  type ModelOutputSearchDeps,
  type ModelOutputSearchEvent,
  type ModelOutputSearchInput,
  type ModelOutputSearchItem,
} from "./models/output_search.ts";
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

// Data search operations
export {
  dataSearch,
  type DataSearchData,
  type DataSearchDeps,
  type DataSearchEvent,
  type DataSearchInput,
  type DataSearchItem,
  parseDuration,
  parseTags,
} from "./data/search.ts";

// Data query operations
export {
  dataQuery,
  type DataQueryData,
  type DataQueryDeps,
  type DataQueryEvent,
  type DataQueryInput,
  type ProjectedData,
} from "./data/query.ts";
export type { DataRecord } from "../domain/data/data_record.ts";

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

// Extension source types
export {
  EXTENSION_KINDS,
  type ExtensionKind,
} from "../domain/repo/swamp_sources.ts";

// Extension source operations
export {
  type SourceListData,
  type SourceListEntry,
  type SourceListEvent,
  type SourceModifyData,
  type SourceModifyEvent,
} from "./sources/source_events.ts";
export {
  createSourceAddDeps,
  sourceAdd,
  type SourceAddDeps,
} from "./sources/add.ts";
export {
  createSourceRemoveDeps,
  sourceRemove,
  type SourceRemoveDeps,
} from "./sources/remove.ts";
export {
  createSourceListDeps,
  sourceList,
  type SourceListDeps,
} from "./sources/list.ts";

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
export {
  typeSearch,
  type TypeSearchData,
  type TypeSearchDeps,
  type TypeSearchEvent,
  type TypeSearchInput,
  type TypeSearchItem,
} from "./types/search.ts";

// Vault type search operations
export {
  vaultTypeSearch,
  type VaultTypeSearchData,
  type VaultTypeSearchDeps,
  type VaultTypeSearchEvent,
  type VaultTypeSearchInput,
  type VaultTypeSearchItem,
} from "./vaults/type_search.ts";

// Vault search operations
export {
  vaultSearch,
  type VaultSearchData,
  type VaultSearchDeps,
  type VaultSearchEvent,
  type VaultSearchInput,
  type VaultSearchItem,
} from "./vaults/search.ts";

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

// Workflow evaluate operations
export {
  createWorkflowEvaluateDeps,
  isWorkflowEvaluateAllData,
  workflowEvaluate,
  type WorkflowEvaluateAllData,
  type WorkflowEvaluateDeps,
  type WorkflowEvaluateEvent,
  type WorkflowEvaluateInput,
  type WorkflowEvaluateItemData,
} from "./workflows/evaluate.ts";

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

// Model evaluate operations
export {
  createModelEvaluateDeps,
  isModelEvaluateAllData,
  modelEvaluate,
  type ModelEvaluateAllData,
  type ModelEvaluateDeps,
  type ModelEvaluateEvent,
  type ModelEvaluateInput,
  type ModelEvaluateItemData,
} from "./models/evaluate.ts";

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

// Vault migrate operations
export {
  createVaultMigrateDeps,
  vaultMigrate,
  type VaultMigrateData,
  type VaultMigrateDeps,
  type VaultMigrateEvent,
  type VaultMigrateInput,
  type VaultMigratePreview,
  vaultMigratePreview,
} from "./vaults/migrate.ts";

// Extension search operations
export {
  extensionSearch,
  type ExtensionSearchData,
  type ExtensionSearchDeps,
  type ExtensionSearchEvent,
  type ExtensionSearchInput,
  type ExtensionSearchItem,
  type ExtensionSearchMeta,
} from "./extensions/search.ts";

// Extension operations
export {
  createExtensionListDeps,
  extensionList,
  type ExtensionListData,
  type ExtensionListDeps,
  type ExtensionListEntry,
  type ExtensionListEvent,
} from "./extensions/list.ts";
export {
  createExtensionFmtDeps,
  extensionFmt,
  type ExtensionFmtCheckData,
  type ExtensionFmtData,
  type ExtensionFmtDeps,
  type ExtensionFmtEvent,
  type ExtensionFmtFixData,
  type ExtensionFmtInput,
} from "./extensions/fmt.ts";
export {
  createExtensionYankDeps,
  extensionYank,
  type ExtensionYankData,
  type ExtensionYankDeps,
  type ExtensionYankEvent,
  type ExtensionYankInput,
  type ExtensionYankPreview,
  extensionYankPreview,
} from "./extensions/yank.ts";
export {
  createExtensionUnyankDeps,
  extensionUnyank,
  type ExtensionUnyankData,
  type ExtensionUnyankDeps,
  type ExtensionUnyankEvent,
  type ExtensionUnyankInput,
  type ExtensionUnyankPreview,
  extensionUnyankPreview,
} from "./extensions/unyank.ts";
export {
  createExtensionQualityDeps,
  extensionQuality,
  type ExtensionQualityData,
  type ExtensionQualityDeps,
  type ExtensionQualityEvent,
  type ExtensionQualityInput,
} from "./extensions/quality.ts";
export {
  computePackageCacheHash,
  defaultPackageCacheRoot,
  ExtensionPackageCache,
  type PackageCacheHashInput,
} from "../domain/extensions/extension_package_cache.ts";
export {
  RUBRIC_VERSION,
  type RubricFactor,
  type RubricScore,
} from "../domain/extensions/extension_rubric_scorer.ts";
export {
  createExtensionUpdateDeps,
  extensionUpdate,
  type ExtensionUpdateDeps,
  type ExtensionUpdateEvent,
  type ExtensionUpdateInput,
} from "./extensions/update.ts";
export type { ExtensionUpdateResult } from "../domain/extensions/extension_update_service.ts";
export {
  createExtensionVersionDeps,
  extensionVersion,
  type ExtensionVersionData,
  type ExtensionVersionDeps,
  type ExtensionVersionEvent,
  type ExtensionVersionInput,
} from "./extensions/version.ts";
export {
  type DatastoreAutoUpdateDeps,
  type DatastoreAutoUpdateResult,
  maybeAutoUpdateDatastoreExtension,
} from "./extensions/datastore_auto_update.ts";
export {
  detectLocalEditsForExtension,
  LocalEditsError,
  type LocalEditsStatus,
} from "./extensions/local_edits.ts";
export {
  type ExtensionUpdateCheckMap,
  type ExtensionUpdateCheckRepository,
  isExtensionCheckStale,
} from "../domain/extensions/extension_update_check_cache.ts";
export { FileExtensionUpdateCheckRepository } from "../infrastructure/persistence/extension_update_check_repository.ts";
export {
  type CompilationError,
  createExtensionPushExecuteDeps,
  createExtensionPushPrepareDeps,
  extensionPush,
  type ExtensionPushCounts,
  type ExtensionPushEvent,
  type ExtensionPushExecuteDeps,
  type ExtensionPushExecuteInput,
  type ExtensionPushMetadata,
  extensionPushPrepare,
  type ExtensionPushPrepared,
  type ExtensionPushPrepareDeps,
  type ExtensionPushPrepareInput,
  type ExtensionPushResolvedData,
  type ExtensionPushSuccessData,
  type ResolvedDatastoreEntry,
  type ResolvedDriverEntry,
  type ResolvedModelEntry,
  type ResolvedReportEntry,
  type ResolvedVaultEntry,
} from "./extensions/push.ts";
export {
  ConflictError,
  createExtensionPullDeps,
  createInstallContext,
  detectConflicts,
  extensionPull,
  type ExtensionPullDeps,
  type ExtensionPullEvent,
  type ExtensionPullInput,
  type ExtensionRef,
  type ExtensionRegistryInfo,
  type ExtensionSafetyWarning,
  type InstallContext,
  installExtension,
  type InstallResult,
  parseExtensionRef,
  resolveServerUrl,
  updateUpstreamExtensions,
  validateExtensionName,
} from "./extensions/pull.ts";
export {
  createExtensionRmDeps,
  extensionRm,
  type ExtensionRmData,
  type ExtensionRmDeps,
  type ExtensionRmEvent,
  type ExtensionRmInput,
  type ExtensionRmPreview,
  extensionRmPreview,
  removeUpstreamExtension,
} from "./extensions/rm.ts";

// Extension layout detection
export {
  classifyExtensionFile,
  detectLegacyExtensionLayout,
  type ExtensionLayoutGeneration,
  type LegacyFileEntry,
  type LegacyLayoutSummary,
  PULLED_TYPE_DIRS,
  requireCurrentExtensionLayout,
  summariseLegacyLayout,
  warnLegacyExtensionLayout,
} from "./extensions/layout.ts";

// Pulled-extension enumeration helper
export {
  enumeratePulledExtensionDirs,
  type PulledExtensionType,
} from "./extensions/enumerate_pulled.ts";

// Extension install (restore from lockfile)
export {
  extensionInstall,
  type ExtensionInstallData,
  type ExtensionInstallDeps,
  type ExtensionInstallEntry,
  type ExtensionInstallEvent,
} from "./extensions/install.ts";

// Model edit operations
export {
  createModelEditDeps,
  modelEdit,
  type ModelEditData,
  type ModelEditDeps,
  type ModelEditEvent,
  type ModelEditInput,
} from "./models/edit.ts";

// Workflow edit operations
export {
  createWorkflowEditDeps,
  workflowEdit,
  type WorkflowEditData,
  type WorkflowEditDeps,
  type WorkflowEditEvent,
  type WorkflowEditInput,
} from "./workflows/edit.ts";

// Vault edit operations
export {
  createVaultEditDeps,
  vaultEdit,
  type VaultEditConfigInfo,
  type VaultEditData,
  type VaultEditDeps,
  type VaultEditEvent,
  type VaultEditInput,
} from "./vaults/edit.ts";

// Model delete operations
export {
  createModelDeleteDeps,
  modelDelete,
  type ModelDeleteData,
  type ModelDeleteDeps,
  type ModelDeleteEvent,
  type ModelDeleteInput,
  type ModelDeletePreview,
  modelDeletePreview,
} from "./models/delete.ts";

// Workflow delete operations
export {
  createWorkflowDeleteDeps,
  workflowDelete,
  type WorkflowDeleteData,
  type WorkflowDeleteDeps,
  type WorkflowDeleteEvent,
  type WorkflowDeleteInput,
  type WorkflowDeletePreview,
  workflowDeletePreview,
} from "./workflows/delete.ts";

// Vault put operations
export {
  createVaultPutDeps,
  vaultPut,
  type VaultPutConfigInfo,
  type VaultPutData,
  type VaultPutDeps,
  type VaultPutEvent,
  type VaultPutInput,
  type VaultPutPreview,
  vaultPutPreview,
} from "./vaults/put.ts";

// Data GC operations
export {
  createDataGcDeps,
  dataGc,
  type DataGcData,
  type DataGcDeps,
  type DataGcEvent,
  type DataGcInput,
  type DataGcPreview,
  dataGcPreview,
  type DataGcPreviewItem,
  type VersionGcPreviewItem,
} from "./data/gc.ts";

// Model create operations
export {
  createModelCreateDeps,
  modelCreate,
  type ModelCreateData,
  type ModelCreateDeps,
  type ModelCreateEvent,
  type ModelCreateInput,
} from "./models/create.ts";

// Workflow create operations
export {
  createWorkflowCreateDeps,
  workflowCreate,
  type WorkflowCreateData,
  type WorkflowCreateDeps,
  type WorkflowCreateEvent,
  type WorkflowCreateInput,
  type WorkflowCreateJobData,
  type WorkflowCreateStepData,
} from "./workflows/create.ts";

// Vault create operations
export {
  createVaultCreateDeps,
  vaultCreate,
  type VaultCreateData,
  type VaultCreateDeps,
  type VaultCreateEvent,
  type VaultCreateInput,
} from "./vaults/create.ts";

// Data rename operations
export {
  createDataRenameDeps,
  dataRename,
  type DataRenameData,
  type DataRenameDeps,
  type DataRenameEvent,
  type DataRenameInput,
} from "./data/rename.ts";

// Auth login operations
export {
  authLogin,
  type AuthLoginData,
  type AuthLoginDeps,
  type AuthLoginEvent,
  type AuthLoginInput,
  type CallbackServerHandle,
  createAuthLoginDeps,
} from "./auth/login.ts";

// Auth logout operations
export {
  authLogout,
  type AuthLogoutData,
  type AuthLogoutDeps,
  type AuthLogoutEvent,
  createAuthLogoutDeps,
} from "./auth/logout.ts";

// Repo init/upgrade operations
export {
  createRepoInitDeps,
  createRepoUpgradeDeps,
  repoInit,
  type RepoInitData,
  type RepoInitDeps,
  type RepoInitEvent,
  type RepoInitInput,
  repoUpgrade,
  type RepoUpgradeData,
  type RepoUpgradeDeps,
  type RepoUpgradeEvent,
  type RepoUpgradeInput,
} from "./repo/init.ts";

// Version operations
export {
  createVersionDeps,
  version,
  type VersionData,
  type VersionDeps,
  type VersionEvent,
  type VersionInput,
} from "./version.ts";

// Telemetry operations
export {
  createTelemetryStatsDeps,
  telemetryStats,
  type TelemetryStatsData,
  type TelemetryStatsDeps,
  type TelemetryStatsEvent,
  type TelemetryStatsInput,
} from "./telemetry/stats.ts";

// Source operations
export {
  createSourcePathDeps,
  sourcePath,
  type SourcePathData,
  type SourcePathDeps,
  type SourcePathEvent,
} from "./source/path.ts";
export {
  createSourceFetchDeps,
  sourceFetch,
  type SourceFetchData,
  type SourceFetchDeps,
  type SourceFetchEvent,
  type SourceFetchInput,
} from "./source/fetch.ts";
export {
  createSourceCleanDeps,
  sourceClean,
  type SourceCleanData,
  type SourceCleanDeps,
  type SourceCleanEvent,
} from "./source/clean.ts";

// Issue operations
export {
  issueCreate,
  type IssueCreateData,
  type IssueCreateDeps,
  type IssueCreateEvent,
  type IssueCreateInput,
} from "./issues/create.ts";
export {
  issueComment,
  type IssueCommentData,
  type IssueCommentDeps,
  type IssueCommentEvent,
  type IssueCommentInput,
  MAX_RIPPLE_LENGTH,
} from "./issues/comment.ts";

// Audit operations
export {
  auditTimeline,
  type AuditTimelineData,
  type AuditTimelineDeps,
  type AuditTimelineEvent,
  type AuditTimelineInput,
  createAuditTimelineDeps,
} from "./audit/timeline.ts";

// Update operations
export {
  createUpdateCheckDeps,
  updateCheck,
  type UpdateCheckData,
  type UpdateCheckDeps,
  type UpdateCheckEvent,
  type UpdateCheckInput,
} from "./update/check.ts";

// Summary operations
export {
  createSummariseDeps,
  summarise,
  type SummariseData,
  type SummariseDeps,
  type SummariseEvent,
  type SummariseInput,
} from "./summary/summarise.ts";

// Doctor (preflight diagnostics)
export {
  type AuditDoctorReport,
  type CheckResult,
  type CheckStatus,
  NoToolConfiguredError,
  type OverallStatus,
  type PreflightCheck,
  type PreflightCheckName,
  type SpawnFn,
} from "../domain/audit/doctor/check.ts";
export {
  auditDoctor,
  type AuditDoctorDeps,
  type AuditDoctorEvent,
  DEFAULT_CHECK_ORDER,
} from "../domain/audit/doctor/doctor_service.ts";
export { todaysAuditFilePath } from "../domain/audit/audit_path.ts";

// Datastore operations
export {
  createDatastoreStatusDeps,
  datastoreStatus,
  type DatastoreStatusData,
  type DatastoreStatusDeps,
  type DatastoreStatusEvent,
} from "./datastores/status.ts";
export {
  createDatastoreSyncDeps,
  type CreateDatastoreSyncDepsOptions,
  datastoreSync,
  type DatastoreSyncData,
  type DatastoreSyncDeps,
  type DatastoreSyncEvent,
  type DatastoreSyncInput,
} from "./datastores/sync.ts";
export {
  createDatastoreSetupDeps,
  type DatastoreSetupData,
  type DatastoreSetupDeps,
  type DatastoreSetupEvent,
  datastoreSetupExtension,
  type DatastoreSetupExtensionInput,
  datastoreSetupFilesystem,
  type DatastoreSetupFilesystemInput,
} from "./datastores/setup.ts";
export {
  createDatastoreLockReleaseDeps,
  createDatastoreLockStatusDeps,
  datastoreLockRelease,
  type DatastoreLockReleaseData,
  type DatastoreLockReleaseDeps,
  type DatastoreLockReleaseEvent,
  type DatastoreLockReleaseInput,
  datastoreLockStatus,
  type DatastoreLockStatusData,
  type DatastoreLockStatusDeps,
  type DatastoreLockStatusEvent,
  type DatastoreLockStatusInput,
  type LockInfo,
} from "./datastores/lock.ts";
