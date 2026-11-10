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

export {
  type AccessDecision,
  type AccessDecisionService,
  type AccessPrincipal,
  type AccessResource,
} from "../domain/access/mod.ts";

export { createLibSwampContext, type LibSwampContext } from "./context.ts";

// internal re-exports only; the runtime constructor stays out of
// extension-facing packages because host and extension cel-js have separate
// class identities, so instanceof fails across them
export { createExtensionCelEnvironment } from "../infrastructure/cel/cel_evaluator.ts";
export type { Environment } from "cel-js";
export {
  alreadyExists,
  cancelled,
  invalidApiKey,
  isSwampError,
  notAuthenticated,
  notFound,
  type SwampError,
  userErrorFromSwampError,
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

export {
  type AuthDeps,
  type AuthWhoamiEvent,
  createAuthDeps,
  rollUpPlanName,
  whoami,
  type WhoamiCollectiveEntitlement,
  type WhoamiIdentity,
} from "./auth/whoami.ts";
export type { WhoamiTrial } from "../infrastructure/http/swamp_club_client.ts";

export {
  billingUrl,
  subscriptionStatus,
  type SubscriptionStatusEvent,
  type SubscriptionStatusView,
} from "./subscription/status.ts";
export {
  createSubscriptionStartDeps,
  subscriptionStart,
  type SubscriptionStartBrowser,
  type SubscriptionStartDeps,
  type SubscriptionStartEvent,
  type SubscriptionStartInput,
  type SubscriptionStartResult,
} from "./subscription/start.ts";

export {
  createInboxListDeps,
  type CreateInboxListDepsOptions,
  DEFAULT_INBOX_LIST_LIMIT,
  inboxBrowse,
  type InboxBrowseEvent,
  type InboxBrowseView,
  inboxList,
  type InboxListDeps,
  type InboxListEvent,
  type InboxListInput,
  type InboxListItem,
  type InboxListView,
  type InboxMessageView,
  MAX_INBOX_LIST_LIMIT,
} from "./inbox/list.ts";
export {
  createInboxMarkSession,
  createInboxReadDeps,
  type CreateInboxReadDepsOptions,
  INBOX_REFRESH_TIMEOUT_MS,
  type InboxMarkOutcome,
  type InboxMarkSession,
  type InboxMarkSessionOptions,
  inboxReadById,
  type InboxReadDeps,
  inboxReadNext,
  type InboxReadNextEvent,
  type InboxReadNextView,
} from "./inbox/read.ts";
export {
  createInboxNoticeDeps,
  type CreateInboxNoticeDepsOptions,
  type InboxNoticeDeps,
  type InboxPoll,
  showInboxNotice,
  startInboxPoll,
} from "./inbox/notice.ts";

export {
  type AccountNoticeDeps,
  type AccountNoticePoll,
  type AccountNoticeView,
  createAccountNoticeDeps,
  type CreateAccountNoticeDepsOptions,
  refreshAccountNotices,
  showAccountNotice,
  startAccountNoticePoll,
} from "./account_notices/notice.ts";

export {
  deferCompletedForOutputs,
  type ExecutionEventWithOutputs,
  extractStepArtifacts,
  inputValidationFailed,
  mapWorkflowExecutionEvent,
  type NestedSignalWaitData,
  resolveCompletedRunOutputs,
  type RunStepOutputs,
  toRunData,
  type WaitKeyHolder,
  withRunStepOutputs,
  workflowExecutionFailed,
  workflowNotFound,
  workflowRun,
  type WorkflowRunDeps,
  type WorkflowRunEvent,
  type WorkflowRunInput,
  type WorkflowRunJobInfo,
  type WorkflowTelemetrySink,
} from "./workflows/run.ts";
export {
  type SkippedSupersedeData,
  type SupersedeResult,
  supersedeSuspendedRuns,
} from "./workflows/supersede.ts";
export {
  type AwaitingParentData,
  awaitingParentOf,
  type DetachedNestedRunData,
  detachedNestedRunsOf,
  type NestedWaitGateDetails,
  nestedWaitGateOf,
  type OrphanedNestedRunDetails,
  orphanedNestedRunError,
  orphanedNestedRunOf,
} from "./workflows/nested_runs.ts";
export {
  type CascadedNestedRunData,
  createNestedCascade,
  emptyNestedCascade,
  mergeNestedCascade,
  type NestedCascade,
  type NestedCascadeDeps,
  nestedCascadeFields,
  type NestedCascadeResult,
} from "./workflows/nested_cascade.ts";
export { NestedRunPendingError } from "../domain/workflows/nested_run_link.ts";
export { inputsMatch } from "../domain/workflows/input_matching.ts";
export type { MethodExecutionEvent } from "../domain/models/method_events.ts";
export {
  type ApprovalView,
  type AssertResultView,
  type DataArtifactRefData,
  extractFirstStepError,
  type JobRunView,
  type StepArtifactsData,
  type StepRunView,
  type StepSkipReasonView,
  type WorkflowRunView,
} from "./workflows/workflow_run_view.ts";

export {
  type AssertSeverity,
  AssertSeveritySchema,
} from "../domain/workflows/step_task.ts";

export { severityAtOrAbove } from "../domain/workflows/assert_severity.ts";

export {
  type ActiveRunHook,
  type CronFireDedupCallback,
  normalizeFireTime,
  type ScheduledExecutionDeps,
  type ScheduledExecutionEvent,
  type ScheduledExecutionEventHandler,
  ScheduledExecutionService,
  type ScheduledRunAuthorization,
  type ScheduledRunAuthorizer,
  type ScheduledRunRequest,
  type TriggerOverride,
  type WorkflowExecutor,
} from "./workflows/scheduled_execution.ts";
export { WorkflowWatcher } from "./workflows/watcher.ts";
export {
  type ScheduleEntry,
  type ScheduleFireCallback,
  WorkflowScheduler,
} from "../domain/workflows/workflow_scheduler.ts";

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
  workflowRunSummary,
  type WorkflowRunSummaryData,
  type WorkflowRunSummaryDeps,
  type WorkflowRunSummaryEvent,
  type WorkflowRunSummaryInput,
} from "./workflows/run_summary.ts";
export {
  type HistorySkippedWorkflow,
  workflowHistorySearch,
  type WorkflowHistorySearchData,
  type WorkflowHistorySearchDeps,
  type WorkflowHistorySearchEvent,
  type WorkflowHistorySearchInput,
  type WorkflowHistorySearchItem,
} from "./workflows/history_search.ts";

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
  methodKindOf,
  type MethodRunLockMode,
  methodRunLockMode,
} from "./models/method_run_lock_mode.ts";
export {
  autoDefinitionLockKey,
  type DirectExecutionDeps,
  type DirectExecutionResult,
  resolveOrCreateDefinition,
  type RoutedInputs,
  routeInputsBySchema,
} from "./models/direct_execution.ts";
export {
  type DataArtifactView,
  type ModelMethodRunView,
  type ModelReportView,
  type ReportResultView,
  type UnpublishedVersionView,
} from "./models/model_method_run_view.ts";

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
  type StalenessState,
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
  createDoctorSecretsDeps,
  doctorSecrets,
  type DoctorSecretsData,
  type DoctorSecretsDeps,
  type DoctorSecretsEvent,
  type SensitiveArgRemediation,
  type SensitiveLeakFinding,
  type UnresolvedDefinition,
} from "./models/doctor_secrets.ts";
export {
  createDoctorVaultsDeps,
  doctorVaults,
  type DoctorVaultsData,
  type DoctorVaultsDeps,
  type DoctorVaultsEvent,
  type UnresolvedVaultDefinition,
  type VaultRequiredFinding,
} from "./models/doctor_vaults.ts";
export {
  cacheWipeRefusal,
  type CatalogCompletenessSummary,
  type CatalogIndexRepairResult,
  type CatalogShortfall,
  type DatastoreFormatMarkerRepairData,
  type DatastoreHealthFinding,
  doctorDatastores,
  type DoctorDatastoresData,
  type DoctorDatastoresDeps,
  type DoctorDatastoresEvent,
  type DoctorDatastoresOptions,
  type LostFormatMarkerState,
  MIXED_KIND_NAMES_LISTED,
  mixedKindNamesFindingMessage,
  type MixedKindNamesSummary,
  type NamespaceContaminationFinding,
  type PreV3RecordsRepairData,
  repairCatalogDuplicateLatest,
  type RepairCatalogDuplicateLatestDeps,
  type RepairCatalogDuplicateLatestEvent,
  repairCatalogIndex,
  type RepairCatalogIndexDeps,
  type RepairCatalogIndexEvent,
  repairDatastoreContamination,
  repairDatastoreFormatMarker,
  type RepairDatastoreFormatMarkerDeps,
  type RepairDatastoreFormatMarkerEvent,
  type RepairDatastoresDeps,
  type RepairDatastoresEvent,
  type RepairDatastoresResult,
  repairPreV3Records,
  type RepairPreV3RecordsDeps,
  type RepairPreV3RecordsEvent,
  repairUnmigratedData,
  type RepairUnmigratedDataDeps,
  type RepairUnmigratedDataEvent,
  repairUnpushedCacheFiles,
  type RepairUnpushedFilesDeps,
  type RepairUnpushedFilesEvent,
  repairUnreadableVersions,
  type RepairUnreadableVersionsDeps,
  type RepairUnreadableVersionsEvent,
  retentionFindingMessage,
  type UnmigratedDataRepairResult,
  unpushedFilesClear,
  type UnpushedFilesFinding,
  unpushedRepairUnsupportedMessage,
  type UnreadableRecordKey,
  type UnreadableRecordRepair,
  type UnreadableVersionsRepairOps,
  type UnreadableVersionsRepairResult,
  type UnreadableVersionsSummary,
  type V3ContentSummary,
  type VaultMismatchFinding,
} from "./datastores/doctor_datastores.ts";
export {
  RETENTION_CHECK_ITEM_LIMIT,
  retentionCheckFailed,
  type RetentionCheckSummary,
  type RetentionCheckWatermark,
  type RetentionKindCheck,
  type RetentionOverdueItem,
  type RetentionScanSources,
  retentionScanSourcesFor,
  type RetentionV3HistoryCheck,
  scanRetention,
} from "./datastores/retention_check.ts";
export {
  modelOutputSearch,
  type ModelOutputSearchCandidate,
  type ModelOutputSearchData,
  type ModelOutputSearchDeps,
  type ModelOutputSearchEvent,
  type ModelOutputSearchInput,
  type ModelOutputSearchItem,
  type ModelOutputSearchKey,
  type ModelOutputSearchModel,
  type ModelOutputSearchNewestFirst,
  type ModelOutputSearchOutput,
  type ModelOutputSearchSelector,
} from "./models/output_search.ts";
export {
  type ModelUsageOutputGroup,
  type ModelUsageRecentOutput,
  modelUsageSummary,
  type ModelUsageSummaryData,
  type ModelUsageSummaryDeps,
  type ModelUsageSummaryEvent,
  type ModelUsageSummaryInput,
  type ModelUsageSummaryModel,
} from "./models/usage_summary.ts";
export {
  type ArtifactsData,
  createModelOutputGetDeps,
  type ErrorData,
  type GlobalOutputInfo,
  modelOutputGet,
  type ModelOutputGetData,
  type ModelOutputGetDeps,
  type ModelOutputGetEvent,
  type ModelOutputGetOptions,
  type OutputInfo,
  type ProvenanceData,
} from "./models/output_get.ts";
export {
  type OutputIdReference,
  type OutputIdReferenceDeps,
  type OutputMatchResult,
  type OutputReference,
  type OutputReferenceDeps,
  resolveOutputIdReference,
  resolveOutputReference,
  type TypedOutput,
} from "./models/output_reference.ts";
export {
  createModelMethodDescribeDeps,
  modelMethodDescribe,
  type ModelMethodDescribeData,
  type ModelMethodDescribeDeps,
  type ModelMethodDescribeEvent,
} from "./models/method_describe.ts";

export {
  createWorkflowGetDeps,
  isUuid,
  workflowGet,
  type WorkflowGetData,
  type WorkflowGetDeps,
  type WorkflowGetEvent,
  type WorkflowGetJobDependency,
  type WorkflowGetStepDependency,
} from "./workflows/get.ts";
export {
  createWorkflowHistoryGetDeps,
  receiptsOfRunView,
  workflowHistoryGet,
  type WorkflowHistoryGetDeps,
  type WorkflowHistoryGetEvent,
  type WorkflowHistoryGetOptions,
} from "./workflows/history_get.ts";
export {
  createWorkflowApproveDeps,
  workflowApprove,
  type WorkflowApproveData,
  type WorkflowApproveDeps,
  type WorkflowApproveEvent,
  type WorkflowApproveInput,
} from "./workflows/approve.ts";
export {
  createWorkflowRejectDeps,
  workflowReject,
  type WorkflowRejectData,
  type WorkflowRejectDeps,
  type WorkflowRejectEvent,
  type WorkflowRejectInput,
} from "./workflows/reject.ts";
export {
  CANCEL_SUSPENDED_NOT_FOUND,
  CANCEL_SUSPENDED_NOT_SUSPENDED,
  type CancelTargetWorkflow,
  createWorkflowCancelSuspendedDeps,
  type LocatedSuspendedRun,
  type LocateSuspendedRunInput,
  locateSuspendedRunToCancel,
  type RunOwnerVerdict,
  workflowCancelSuspended,
  type WorkflowCancelSuspendedData,
  type WorkflowCancelSuspendedDeps,
  type WorkflowCancelSuspendedEvent,
  type WorkflowCancelSuspendedInput,
} from "./workflows/cancel_suspended.ts";
export {
  createWorkflowApprovalsDeps,
  type ExpiredApproval,
  type PendingApproval,
  workflowApprovals,
  type WorkflowApprovalsData,
  type WorkflowApprovalsDeps,
  type WorkflowApprovalsEvent,
} from "./workflows/approvals.ts";
export {
  createWorkflowSignalDeps,
  type PendingSignalReceipt,
  type SignalLastWait,
  signalLastWait,
  type SignalRefusalKind,
  signalRefusalKind,
  type SignalWaitSubject,
  workflowSignal,
  type WorkflowSignalAddress,
  type WorkflowSignalData,
  type WorkflowSignalDeps,
  type WorkflowSignalEvent,
  type WorkflowSignalInput,
  type WorkflowSignalPendingData,
} from "./workflows/signal.ts";
export {
  createWorkflowWaitsDeps,
  type PendingSignalInfo,
  type SignalledWaitInfo,
  type SignalWaitInfo,
  type UnreadableWaitInfo,
  workflowWaits,
  type WorkflowWaitsData,
  type WorkflowWaitsDeps,
  type WorkflowWaitsEvent,
  type WorkflowWaitsOptions,
} from "./workflows/waits.ts";

export {
  createVaultGetDeps,
  type VaultConfigInfo,
  type VaultConfigRepository,
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

export {
  createDataGetDeps,
  dataGet,
  type DataGetData,
  type DataGetDeps,
  type DataGetEvent,
  type DataGetInput,
  type DataOwnerInfo,
  resolveWorkflowData,
  type WorkflowDataLocation,
  type WorkflowDataMatchInfo,
  type WorkflowDataPin,
  type WorkflowDataQuery,
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

export {
  dataQuery,
  type DataQueryData,
  type DataQueryDeps,
  type DataQueryEvent,
  type DataQueryInput,
  parseQuerySort,
  type ProjectedData,
  type QuerySort,
  type QuerySortDirection,
  requireSingleResult,
  type SpecNameHint,
} from "./data/query.ts";
export type { DataRecord } from "../domain/data/data_record.ts";

export {
  createWorkerListDeps,
  effectiveTokenState,
  workerList,
  type WorkerListData,
  type WorkerListDeps,
  type WorkerListEvent,
  type WorkerListItem,
  type WorkerListOptions,
  workerTokenList,
  type WorkerTokenListData,
  type WorkerTokenListEvent,
  type WorkerTokenListItem,
} from "./worker/list.ts";
export {
  createWorkerTokenCreateDeps,
  workerTokenCreate,
  type WorkerTokenCreateData,
  type WorkerTokenCreateDeps,
  type WorkerTokenCreateEvent,
  type WorkerTokenCreateInput,
} from "./worker/token_create.ts";
export type { MaxEnrollments } from "./worker/token_create.ts";
export {
  createWorkerTokenRevokeDeps,
  workerTokenRevoke,
  type WorkerTokenRevokeData,
  type WorkerTokenRevokeDeps,
  type WorkerTokenRevokeEvent,
  type WorkerTokenRevokeInput,
} from "./worker/token_revoke.ts";
export { createWorkerModelRunDeps } from "./worker/run_deps.ts";
export {
  createWorkerQueueListDeps,
  workerQueueList,
  type WorkerQueueListData,
  type WorkerQueueListDeps,
  type WorkerQueueListEvent,
  type WorkerQueueListItem,
} from "./worker/queue_list.ts";
export {
  createWorkerLeaseListDeps,
  workerLeaseList,
  type WorkerLeaseListData,
  type WorkerLeaseListDeps,
  type WorkerLeaseListEvent,
  type WorkerLeaseListItem,
  type WorkerLeaseListOptions,
} from "./worker/lease_list.ts";
export {
  type PrunableToken,
  type PrunableWorker,
  workerPrune,
  type WorkerPruneDeps,
  type WorkerPruneEvent,
  type WorkerPruneInput,
  type WorkerPruneResult,
} from "./worker/prune.ts";

export {
  createServerTokenCreateDeps,
  serverTokenCreate,
  type ServerTokenCreateData,
  type ServerTokenCreateDeps,
  type ServerTokenCreateEvent,
  type ServerTokenCreateInput,
} from "./access/token_create.ts";
export {
  createIntegrationListDeps,
  integrationList,
  type IntegrationListData,
  type IntegrationListDeps,
  type IntegrationListEvent,
  type IntegrationView,
  integrationView,
} from "./access/integration_list.ts";
export {
  createDelegationListDeps,
  delegationList,
  type DelegationListData,
  type DelegationListDeps,
  type DelegationListEvent,
  type DelegationListInput,
  type DelegationView,
  delegationView,
  type DelegationViewState,
} from "./access/delegation_list.ts";
export {
  createDelegationEndDeps,
  delegationEnd,
  type DelegationEndData,
  type DelegationEndDeps,
  type DelegationEndEvent,
  type DelegationEndInput,
  OPERATOR_END_CAUSE,
} from "./access/delegation_end.ts";
export {
  createServerTokenListDeps,
  serverTokenList,
  type ServerTokenListData,
  type ServerTokenListDeps,
  type ServerTokenListEvent,
  type ServerTokenListItem,
} from "./access/token_list.ts";
export {
  createServerTokenRevokeDeps,
  serverTokenRevoke,
  type ServerTokenRevokeData,
  type ServerTokenRevokeDeps,
  type ServerTokenRevokeEvent,
  type ServerTokenRevokeInput,
} from "./access/token_revoke.ts";
export {
  createServerTokenRevealDeps,
  serverTokenReveal,
  type ServerTokenRevealData,
  type ServerTokenRevealDeps,
  type ServerTokenRevealEvent,
} from "./access/token_reveal.ts";
export {
  createServerTokenRotateDeps,
  serverTokenRotate,
  type ServerTokenRotateData,
  type ServerTokenRotateDeps,
  type ServerTokenRotateEvent,
  type ServerTokenRotateInput,
} from "./access/token_rotate.ts";
export { createServerTokenRunDeps } from "./access/run_deps.ts";
export {
  explainedAccessResource,
  type ExplainedResourceDeps,
} from "./access/explained_resource.ts";

export {
  createNamespace,
  formatNamespacedModelName,
  isEmptyNamespace,
  type Namespace,
  type NamespacedModelName,
  parseNamespacedModelName,
  SOLO_NAMESPACE,
} from "../domain/data/namespace.ts";

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

export {
  EXTENSION_KINDS,
  type ExtensionKind,
} from "../domain/repo/swamp_sources.ts";

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
export { type ResolvedSkill } from "./sources/source_skills.ts";
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

export {
  createTypeDescribeDeps,
  typeDescribe,
  type TypeDescribeData,
  type TypeDescribeDeps,
  type TypeDescribeEvent,
} from "./types/describe.ts";
export {
  buildDataOutputSpecs,
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

export {
  vaultTypeSearch,
  type VaultTypeSearchData,
  type VaultTypeSearchDeps,
  type VaultTypeSearchEvent,
  type VaultTypeSearchInput,
  type VaultTypeSearchItem,
} from "./vaults/type_search.ts";

export {
  datastoreTypeSearch,
  type DatastoreTypeSearchData,
  type DatastoreTypeSearchDeps,
  type DatastoreTypeSearchEvent,
  type DatastoreTypeSearchInput,
  type DatastoreTypeSearchItem,
} from "./datastores/type_search.ts";

export {
  reportTypeSearch,
  type ReportTypeSearchData,
  type ReportTypeSearchDeps,
  type ReportTypeSearchEvent,
  type ReportTypeSearchInput,
  type ReportTypeSearchItem,
} from "./reports/type_search.ts";

export {
  vaultSearch,
  type VaultSearchData,
  type VaultSearchDeps,
  type VaultSearchEvent,
  type VaultSearchInput,
  type VaultSearchItem,
} from "./vaults/search.ts";

export {
  workflowSchema,
  type WorkflowSchemaData,
  type WorkflowSchemaEvent,
} from "./workflows/schema.ts";

export {
  type BrokenWorkflow,
  findBrokenWorkflow,
  listBrokenWorkflows,
  workflowsDirFor,
} from "./workflows/broken_workflow.ts";

export {
  createWorkflowValidateDeps,
  isWorkflowValidateAllData,
  pulledExtensionWorkflowScope,
  type ValidationItemData as WorkflowValidationItemData,
  workflowValidate,
  type WorkflowValidateAllData,
  type WorkflowValidateData,
  type WorkflowValidateDeps,
  type WorkflowValidateEvent,
  type WorkflowValidateInput,
} from "./workflows/validate.ts";

export {
  doctorWorkflowDirs,
  type DoctorWorkflowRepos,
  type DoctorWorkflowResult,
  doctorWorkflows,
  type DoctorWorkflowsDeps,
  type DoctorWorkflowsEvent,
  type DoctorWorkflowsReport,
} from "./workflows/doctor.ts";

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

export {
  createWorkflowHistoryLogsDeps,
  workflowHistoryLogs,
  type WorkflowHistoryLogsCompletedData,
  type WorkflowHistoryLogsDeps,
  type WorkflowHistoryLogsEvent,
  type WorkflowHistoryLogsInput,
} from "./workflows/history_logs.ts";
export {
  AMBIGUOUS_GATE_CODE,
  GATE_REOPENED_CODE,
  type GateTarget,
} from "./workflows/gate_refusals.ts";
export { exactRunReference } from "./workflows/run_lookup.ts";
export {
  resolveRunReference,
  type RunReference,
  type RunReferenceDeps,
} from "./workflows/run_reference.ts";

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

export {
  createModelMethodHistoryLogsDeps,
  type MethodHistoryLogsCompletedData,
  modelMethodHistoryLogs,
  type ModelMethodHistoryLogsDeps,
  type ModelMethodHistoryLogsEvent,
  type ModelMethodHistoryLogsInput,
} from "./models/method_history_logs.ts";

export {
  createModelOutputLogsDeps,
  modelOutputLogs,
  type ModelOutputLogsData,
  type ModelOutputLogsDeps,
  type ModelOutputLogsEvent,
  type ModelOutputLogsInput,
} from "./models/output_logs.ts";

export {
  createModelOutputDataDeps,
  modelOutputData,
  type ModelOutputDataData,
  type ModelOutputDataDeps,
  type ModelOutputDataEvent,
  type ModelOutputDataInput,
} from "./models/output_data.ts";

export {
  createVaultListKeysDeps,
  vaultListKeys,
  type VaultListKeysData,
  type VaultListKeysDeps,
  type VaultListKeysEvent,
  type VaultListKeysInput,
} from "./vaults/list_keys.ts";

export {
  createVaultReadSecretDeps,
  vaultReadSecret,
  type VaultReadSecretData,
  type VaultReadSecretDeps,
  type VaultReadSecretEvent,
  type VaultReadSecretInput,
} from "./vaults/read_secret.ts";

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
export {
  describeVaultTargetConfig,
  type VaultTypeConfigDeps,
} from "./vaults/config_fields.ts";
export {
  findMissingRequiredFields,
  isSecretLikeFieldName,
  type VaultConfigField,
} from "../domain/vaults/vault_config_fields.ts";

export {
  extensionSearch,
  type ExtensionSearchData,
  type ExtensionSearchDeps,
  type ExtensionSearchEvent,
  type ExtensionSearchInput,
  type ExtensionSearchItem,
  type ExtensionSearchMeta,
} from "./extensions/search.ts";

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
  createExtensionVisibilityDeps,
  type ExtensionVisibility,
  extensionVisibility,
  type ExtensionVisibilityData,
  type ExtensionVisibilityDeps,
  type ExtensionVisibilityEvent,
  type ExtensionVisibilityInput,
} from "./extensions/visibility.ts";
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
  createExtensionDeprecateDeps,
  extensionDeprecate,
  type ExtensionDeprecateData,
  type ExtensionDeprecateDeps,
  type ExtensionDeprecateEvent,
  type ExtensionDeprecateInput,
  type ExtensionDeprecatePreview,
  extensionDeprecatePreview,
} from "./extensions/deprecate.ts";
export {
  createExtensionUndeprecateDeps,
  extensionUndeprecate,
  type ExtensionUndeprecateData,
  type ExtensionUndeprecateDeps,
  type ExtensionUndeprecateEvent,
  type ExtensionUndeprecateInput,
  type ExtensionUndeprecatePreview,
  extensionUndeprecatePreview,
} from "./extensions/undeprecate.ts";
export {
  createExtensionPromoteDeps,
  extensionPromote,
  type ExtensionPromoteData,
  type ExtensionPromoteDeps,
  type ExtensionPromoteEvent,
  type ExtensionPromoteInput,
  extensionPromoteValidate,
} from "./extensions/promote.ts";
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
  type FactorStatus,
  RUBRIC_VERSION,
} from "@swamp-club/extension-scoring/rubric";
export {
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
  createExtensionInfoDeps,
  extensionInfo,
  type ExtensionInfoData,
  type ExtensionInfoDeps,
  type ExtensionInfoEvent,
  type ExtensionInfoInput,
} from "./extensions/info.ts";
export type {
  ExtensionContentMetadata,
  ExtractedArgument,
  ExtractedDatastore,
  ExtractedExtension,
  ExtractedMethod,
  ExtractedModel,
  ExtractedReport,
  ExtractedSkill,
  ExtractedVault,
  ExtractedWorkflow,
} from "../domain/extensions/extension_content.ts";
export {
  detectLocalEditsForExtension,
  LocalEditsError,
  type LocalEditsStatus,
} from "./extensions/local_edits.ts";
export {
  extensionCacheKey,
  type ExtensionUpdateCheckMap,
  type ExtensionUpdateCheckRepository,
  isExtensionCheckStale,
} from "../domain/extensions/extension_update_check_cache.ts";
export { FileExtensionUpdateCheckRepository } from "../infrastructure/persistence/extension_update_check_repository.ts";
export {
  type CollectiveLookup,
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
  type ExtensionPushPrepareDepsOptions,
  type ExtensionPushPrepareInput,
  type ExtensionPushResolvedData,
  type ExtensionPushSuccessData,
  type ResolvedDatastoreEntry,
  type ResolvedModelEntry,
  type ResolvedReportEntry,
  type ResolvedVaultEntry,
} from "./extensions/push.ts";
export {
  type DeclaredAcceptance,
  type DeclaredAcceptances,
  type LocalGate,
  type LocalGateFailure,
  type LocalGatesMode,
  type QualityFindings,
} from "./extensions/push.ts";
export {
  type ApiCallRecord,
  type CollectiveEntitlement,
  type CollectiveTrial,
  REGISTRY_CHECK_LABELS,
  type RegistryCheckNotRunCause,
  type RegistryCheckResult,
  type RegistryChecksMode,
  registryChecksVerdict,
} from "../domain/extensions/extension_publish_checks.ts";
export {
  type ApiCallRecorder,
  createApiCallRecorder,
} from "../infrastructure/http/recording_fetcher.ts";
export {
  type PublishVisibility,
  resolvePublishVisibility,
} from "../domain/extensions/extension_manifest.ts";
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
  isScopedExtensionName,
  isVersionConstraint,
  parseExtensionRef,
  resolveServerUrl,
  type ShadowedTypeInfo,
  type UnoptedPrereleaseNotice,
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
} from "./extensions/rm.ts";

// writes to a datastore-shared lockfile fetch it under the datastore global
// lock first
export {
  createRepoPendingLockfileStore,
  createRootLockfileSync,
  LockfilePublishWiringError,
  type LockfileTransaction,
  type ManagedLockfileLock,
  type ManagedLockfileSyncPort,
  ManagedLockfileTransaction,
  type ManagedLockfileTransactionOptions,
  ManagedLockfileUnpublishedError,
  type PendingLockfileDeltaStore,
  refreshManagedLockfile,
  withManagedLockfileTransaction,
} from "./extensions/managed_lockfile_transaction.ts";

// Lockfile repository — sole gateway for upstream_extensions.json.
export { LockfileRepository } from "../infrastructure/persistence/lockfile_repository.ts";

export { InstallExtensionService } from "./extensions/install_extension_service.ts";
export {
  type FailedFile,
  type RemoveExtensionResult,
  RemoveExtensionService,
  type RetainedFile,
} from "./extensions/remove_extension_service.ts";
export { UpgradeExtensionService } from "./extensions/upgrade_extension_service.ts";
export {
  recoverPulledExtensionStaging,
  type RecoverStagingOptions,
  type StagingRecoveryReport,
} from "./extensions/recover_staging.ts";

export {
  ReconcileFromDiskService,
  type ReconcileResult,
  type ReconcileTransition,
  type UncataloguedPulledResult,
} from "./extensions/reconcile_from_disk_service.ts";

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

export {
  choosePulledDatastoreDirsOnDisk,
  enumeratePulledDatastoreExtensionsOnDisk,
  enumeratePulledExtensionDirs,
  type OnDiskDatastoreExtension,
  type PulledExtensionType,
} from "./extensions/enumerate_pulled.ts";

export {
  extensionInstall,
  type ExtensionInstallData,
  type ExtensionInstallDeps,
  type ExtensionInstallEntry,
  type ExtensionInstallEvent,
} from "./extensions/install.ts";

export {
  DOCTOR_REGISTRY_ORDER,
  doctorExtensions,
  type DoctorExtensionsDeps,
  type DoctorExtensionsEvent,
  type DoctorExtensionsReport,
  type DoctorMemberCollision,
  type DoctorOverallStatus,
  type DoctorRegistryDeps,
  type DoctorRegistryName,
  type DoctorRegistryResult,
  type DoctorRescanSkipped,
  type DoctorWarning,
  extensionMemberDoctorDeps,
  toDoctorWarnings,
} from "./extensions/doctor.ts";

export {
  ROW_STATE_TAGS,
  type RowStateTag,
} from "../domain/extensions/row_state.ts";

export {
  buildAggregateState,
  type DoctorAggregateReport,
  type DoctorAggregateSummary,
  type DoctorBundleOrphan,
  type DoctorCatalogOrphan,
  type DoctorSourceDetail,
  enumerateBundleFiles,
} from "./extensions/doctor_aggregate.ts";

export {
  type RepairDeps,
  repairExtensions,
  type RepairOperation,
  type RepairOperationKind,
  type RepairReport,
} from "./extensions/doctor_repair.ts";

export {
  createModelEditDeps,
  modelEdit,
  type ModelEditData,
  type ModelEditDeps,
  type ModelEditEvent,
  type ModelEditFile,
  type ModelEditInput,
  type ModelEditTarget,
  resolveModelEditFile,
} from "./models/edit.ts";

export {
  createEditorSessionDeps,
  editInEditor,
  type EditorLaunchingData,
  type EditorSessionDeps,
  type EditorSessionInput,
  type EditorSessionResult,
} from "./editor_session.ts";

export {
  createWorkflowEditDeps,
  resolveWorkflowEditFile,
  workflowEdit,
  type WorkflowEditData,
  type WorkflowEditDeps,
  type WorkflowEditEvent,
  type WorkflowEditFile,
  type WorkflowEditInput,
  type WorkflowEditTarget,
} from "./workflows/edit.ts";

export {
  createVaultEditDeps,
  findVaultByNameOrId,
  resolveVaultEditFile,
  vaultEdit,
  type VaultEditConfigInfo,
  type VaultEditData,
  type VaultEditDeps,
  type VaultEditEvent,
  type VaultEditFile,
  type VaultEditInput,
  type VaultEditLookupDeps,
  VaultSaveOutcomeUnknownError,
} from "./vaults/edit.ts";

export {
  createModelDeleteDeps,
  modelDelete,
  type ModelDeleteData,
  type ModelDeleteDeps,
  type ModelDeleteEvent,
  type ModelDeleteInput,
  type ModelDeletePlan,
  type ModelDeletePreview,
  modelDeletePreview,
} from "./models/delete.ts";

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

export {
  createWorkflowScheduleDeps,
  type LiveSchedule,
  overrideSchedulesOf,
  parsePauseUntil,
  type ScheduleListEntry,
  type ScheduleSource,
  type WorkflowScheduleDeps,
  workflowScheduleList,
  type WorkflowScheduleListData,
  type WorkflowScheduleListEvent,
  workflowSchedulePause,
  type WorkflowSchedulePauseData,
  type WorkflowSchedulePauseEvent,
  type WorkflowSchedulePauseInput,
  workflowScheduleResume,
  type WorkflowScheduleResumeData,
  type WorkflowScheduleResumeEvent,
  type WorkflowScheduleResumeInput,
  type WorkflowScheduleTarget,
} from "./workflows/schedule.ts";

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

export {
  createVaultDeleteDeps,
  vaultDelete,
  type VaultDeleteConfigInfo,
  type VaultDeleteData,
  type VaultDeleteDeps,
  type VaultDeleteEvent,
  type VaultDeleteInput,
  type VaultDeletePreview,
  vaultDeletePreview,
} from "./vaults/delete.ts";

export {
  createVaultRemoveDeps,
  vaultRemove,
  type VaultRemoveData,
  type VaultRemoveDeps,
  type VaultRemoveEvent,
  type VaultRemoveInput,
  type VaultRemoveLocalStorage,
  type VaultRemovePreview,
  vaultRemovePreview,
  type VaultRemoveRepositories,
  vaultRemoveStoredSecrets,
} from "./vaults/remove.ts";

export {
  createVaultAnnotateDeps,
  vaultAnnotate,
  type VaultAnnotateConfigInfo,
  type VaultAnnotateData,
  type VaultAnnotateDeps,
  type VaultAnnotateEvent,
  type VaultAnnotateInput,
} from "./vaults/annotate.ts";

export {
  createVaultInspectDeps,
  vaultInspect,
  type VaultInspectConfigInfo,
  type VaultInspectData,
  type VaultInspectDeps,
  type VaultInspectEvent,
} from "./vaults/inspect.ts";

export {
  createVaultAuditTrailDeps,
  vaultAuditTrail,
  type VaultAuditTrailData,
  type VaultAuditTrailDeps,
  type VaultAuditTrailEvent,
  type VaultAuditTrailInput,
} from "./vaults/audit_trail.ts";

export {
  type AutoGcLifecycleDeps,
  type AutoGcResult,
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

export {
  createDataPruneDeps,
  dataPrune,
  type DataPruneData,
  type DataPruneDeps,
  type DataPruneEvent,
  type DataPruneInput,
  type DataPrunePreview,
  dataPrunePreview,
  type DataPrunePreviewItem,
} from "./data/prune.ts";

export {
  createRunGcDeps,
  DEFAULT_OUTPUT_RETENTION_DAYS,
  DEFAULT_WORKFLOW_RUN_RETENTION_DAYS,
  runGc,
  type RunGcAutoDefinition,
  type RunGcData,
  type RunGcDeps,
  type RunGcEvent,
  type RunGcGarbageCollectionPolicy,
  type RunGcInput,
  runGcInputFromPolicy,
  type RunGcPreview,
  runGcPreview,
  runGcRetentionFromPolicy,
} from "./data/run_gc.ts";

export { type RepoRetentionDeps, runRepoRetention } from "./retention/run.ts";
export {
  AUTO_DEFINITION_RETENTION_LOCK_WAIT_MS,
  type AutoDefinitionRetentionSources,
  autoDefinitionRetentionSourcesOf,
} from "./retention/auto_definitions.ts";
export {
  type RetentionKindResult,
  type RetentionPassResult,
} from "./retention/pass.ts";

export {
  createModelCreateDeps,
  modelCreate,
  type ModelCreateData,
  type ModelCreateDeps,
  type ModelCreateEvent,
  type ModelCreateInput,
} from "./models/create.ts";

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

export {
  createVaultCreateDeps,
  vaultCreate,
  type VaultCreateData,
  type VaultCreateDeps,
  type VaultCreateEvent,
  type VaultCreateInput,
} from "./vaults/create.ts";

export {
  createDataRenameDeps,
  dataRename,
  type DataRenameData,
  type DataRenameDeps,
  type DataRenameEvent,
  type DataRenameInput,
} from "./data/rename.ts";

export {
  type BatchDeleteFilter,
  createDataDeleteDeps,
  dataBatchDelete,
  type DataBatchDeleteData,
  type DataBatchDeleteEvent,
  type DataBatchDeleteInput,
  type DataBatchDeletePreview,
  dataBatchDeletePreview,
  dataDelete,
  type DataDeleteData,
  type DataDeleteDeps,
  type DataDeleteEvent,
  type DataDeleteInput,
  type DataDeletePreview,
  dataDeletePreview,
} from "./data/delete.ts";

export {
  authLogin,
  type AuthLoginData,
  type AuthLoginDeps,
  type AuthLoginEvent,
  type AuthLoginInput,
  CLI_CLIENT_ID,
  createAuthLoginDeps,
} from "./auth/login.ts";

export {
  authTokenCreate,
  type AuthTokenCreateData,
  type AuthTokenCreateDeps,
  type AuthTokenCreateEvent,
  type AuthTokenCreateInput,
  createAuthTokenCreateDeps,
  type CreateAuthTokenCreateDepsOptions,
} from "./auth/token_create.ts";

export {
  authOAuthClientRegister,
  type AuthOAuthClientRegisterData,
  type AuthOAuthClientRegisterDeps,
  type AuthOAuthClientRegisterEvent,
  type AuthOAuthClientRegisterInput,
  createAuthOAuthClientRegisterDeps,
} from "./auth/oauth_client_register.ts";

export {
  authTokenList,
  type AuthTokenListData,
  type AuthTokenListDeps,
  type AuthTokenListEvent,
  type AuthTokenListInput,
  type AuthTokenListItem,
  createAuthTokenListDeps,
  type CreateAuthTokenListDepsOptions,
} from "./auth/token_list.ts";

export {
  authTokenRevoke,
  type AuthTokenRevokeData,
  type AuthTokenRevokeDeps,
  type AuthTokenRevokeEvent,
  type AuthTokenRevokeInput,
  createAuthTokenRevokeDeps,
  type CreateAuthTokenRevokeDepsOptions,
} from "./auth/token_revoke.ts";

export {
  authTokenDelete,
  type AuthTokenDeleteData,
  type AuthTokenDeleteDeps,
  type AuthTokenDeleteEvent,
  type AuthTokenDeleteInput,
  createAuthTokenDeleteDeps,
  type CreateAuthTokenDeleteDepsOptions,
} from "./auth/token_delete.ts";

export {
  authLogout,
  type AuthLogoutData,
  type AuthLogoutDeps,
  type AuthLogoutEvent,
  type AuthLogoutKeyRevocation,
  createAuthLogoutDeps,
} from "./auth/logout.ts";

export {
  type AuthDiscovery,
  createServerLoginDeps,
  DeviceAuthPendingError,
  type DeviceAuthResponse,
  type DeviceTokenResponse,
  serverLogin,
  type ServerLoginData,
  type ServerLoginDeps,
  type ServerLoginEvent,
  type ServerLoginInput,
} from "./auth/server_login.ts";

export type {
  ServerCredential,
  ServerCredentialRepository,
} from "../domain/auth/server_credential.ts";
export { normalizeServerUrl } from "../domain/auth/server_url.ts";
export {
  FileServerCredentialRepository,
  type FileServerCredentialRepositoryOptions,
} from "../infrastructure/persistence/server_credential_repository.ts";

export {
  createRepoInitDeps,
  createRepoUpgradeDeps,
  type FindPrunableSettings,
  type PrunableToolSettings,
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

export {
  createRepoPruneDeps,
  repoPrune,
  type RepoPruneData,
  type RepoPruneDeps,
  type RepoPruneEvent,
  type RepoPruneFailure,
  type RepoPruneInput,
  type RepoPruneItem,
  type RepoPrunePreview,
  repoPrunePreview,
  type RepoPruneSkip,
} from "./repo/prune.ts";

export {
  createVersionDeps,
  version,
  type VersionData,
  type VersionDeps,
  type VersionEvent,
  type VersionInput,
} from "./version.ts";

export {
  createTelemetryStatsDeps,
  type TelemetryOptOutSource,
  telemetryStats,
  type TelemetryStatsData,
  type TelemetryStatsDeps,
  type TelemetryStatsEmptyState,
  type TelemetryStatsEvent,
  type TelemetryStatsInput,
} from "./telemetry/stats.ts";

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
  type IssueStatusTransition,
  MAX_RIPPLE_LENGTH,
} from "./issues/comment.ts";
export {
  issueGet,
  type IssueGetComment,
  type IssueGetData,
  type IssueGetDeps,
  type IssueGetEvent,
  type IssueGetInput,
} from "./issues/get.ts";
export {
  issueEdit,
  type IssueEditData,
  type IssueEditDeps,
  type IssueEditEvent,
  type IssueEditInput,
} from "./issues/edit.ts";
export {
  issueSearch,
  type IssueSearchData,
  type IssueSearchDeps,
  type IssueSearchEvent,
  type IssueSearchInput,
  type IssueSearchItem,
} from "./issues/search.ts";

export {
  inviteLink,
  type InviteLinkData,
  type InviteLinkDeps,
  type InviteLinkEvent,
  type InviteLinkInput,
} from "./invite/link.ts";

export {
  auditTimeline,
  type AuditTimelineData,
  type AuditTimelineDeps,
  type AuditTimelineEvent,
  type AuditTimelineInput,
  createAuditTimelineDeps,
} from "./audit/timeline.ts";

export {
  auditInstall,
  auditUninstall,
  type AuditUserHookData,
  type AuditUserHookDeps,
  type AuditUserHookEvent,
  createAuditUserHookDeps,
  resolveClaudeUserConfigDir,
} from "./audit/install.ts";

export {
  createUpdateCheckDeps,
  updateCheck,
  type UpdateCheckData,
  type UpdateCheckDeps,
  type UpdateCheckEvent,
  type UpdateCheckInput,
} from "./update/check.ts";

export {
  createSummariseDeps,
  summarise,
  type SummariseData,
  type SummariseDeps,
  type SummariseEvent,
  type SummariseInput,
} from "./summary/summarise.ts";

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
  defaultCheckOrder,
} from "../domain/audit/doctor/doctor_service.ts";
export type { ResolveBinary } from "../domain/audit/doctor/checks/resolve_binary.ts";
export { todaysAuditFilePath } from "../domain/audit/audit_path.ts";

export {
  createDatastoreStatusDeps,
  type DatastoreHeldLeaseStatus,
  type DatastoreOutboxEntryStatus,
  type DatastoreQuarantineStatus,
  type DatastoreServeSection,
  datastoreStatus,
  type DatastoreStatusData,
  type DatastoreStatusDeps,
  type DatastoreStatusEvent,
  outboxEntryStatusesOf,
  quarantineStatusOf,
} from "./datastores/status.ts";
export {
  datastoreQuarantineAccept,
  type DatastoreQuarantineAcceptData,
  type DatastoreQuarantineAcceptDeps,
  type DatastoreQuarantineAcceptEvent,
  type DatastoreQuarantineAcceptInput,
  type QuarantineRenumberedVersion,
} from "./datastores/quarantine_accept.ts";
export {
  datastoreQuarantineDiscard,
  type DatastoreQuarantineDiscardData,
  type DatastoreQuarantineDiscardDeps,
  type DatastoreQuarantineDiscardEvent,
  type DatastoreQuarantineDiscardInput,
} from "./datastores/quarantine_discard.ts";
export {
  createDatastoreSyncDeps,
  type CreateDatastoreSyncDepsOptions,
  datastoreSync,
  type DatastoreSyncData,
  type DatastoreSyncDeps,
  type DatastoreSyncEvent,
  type DatastoreSyncInput,
  type DatastoreSyncPreviewData,
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
  type DatastoreSetupWarningData,
  type ManagedConfigTierInspection,
  type ResolveConfigExpressions,
  type ResolveConfigTierPath,
} from "./datastores/setup.ts";
export {
  createDatastoreLockReleaseDeps,
  createDatastoreLockStatusDeps,
  createServeLeaseReleaseDeps,
  createServeMemberLockReleaseDeps,
  createServeMemberLockStatusDeps,
  type CustomModelLockSource,
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
  modelLockKey,
  modelSpecTypeMatches,
  parseModelLockKey,
  parseModelSpec,
  type ServeLeaseStatusData,
  stripNamespacePrefix,
  workflowRunLockKey,
} from "./datastores/lock.ts";
export {
  MAX_LEASE_HOLD_MS,
  MIN_LEASE_HOLD_MS,
  modelLeaseAcquire,
  type ModelLeaseAcquireData,
  type ModelLeaseAcquireEvent,
  type ModelLeaseDeps,
  modelLeaseRelease,
  type ModelLeaseReleaseData,
  type ModelLeaseReleaseEvent,
  modelLeaseStatus,
  type ModelLeaseStatusData,
  type ModelLeaseStatusEvent,
  type ModelLeaseView,
} from "./models/lease.ts";
export {
  datastoreCompact,
  type DatastoreCompactData,
  type DatastoreCompactDeps,
  type DatastoreCompactEvent,
} from "./datastores/compact.ts";
export {
  datastoreGc,
  type DatastoreGcChunkReport,
  type DatastoreGcData,
  type DatastoreGcDeps,
  type DatastoreGcEvent,
} from "./datastores/gc.ts";
export {
  datastoreClaim,
  type DatastoreClaimCommitLog,
  type DatastoreClaimData,
  type DatastoreClaimDeps,
  type DatastoreClaimEvent,
  type DatastoreClaimInput,
} from "./datastores/claim.ts";
export {
  datastoreRelease,
  type DatastoreReleaseData,
  type DatastoreReleaseEvent,
} from "./datastores/release.ts";
export {
  createMigrateIndexDeps,
  type CreateMigrateIndexDepsOptions,
  datastoreMigrateIndex,
  type MigrateIndexData,
  type MigrateIndexDeps,
  type MigrateIndexEvent,
  type MigrateIndexResult,
} from "./datastores/migrate_index.ts";
export {
  datastoreNamespaceSet,
  type NamespaceSetData,
  type NamespaceSetDeps,
  type NamespaceSetEvent,
  type NamespaceSetInput,
} from "./datastores/namespace_set.ts";
export {
  datastoreNamespaceUnset,
  type NamespaceUnsetData,
  type NamespaceUnsetDeps,
  type NamespaceUnsetEvent,
} from "./datastores/namespace_unset.ts";
export {
  createNamespaceListDeps,
  datastoreNamespaceList,
  type NamespaceInfo,
  type NamespaceListData,
  type NamespaceListDeps,
  type NamespaceListEvent,
} from "./datastores/namespace_list.ts";
export {
  datastoreNamespaceMigrate,
  type DirSize,
  INFRASTRUCTURE_FILES,
  type MergeDirResult,
  type NamespaceMigrateCompletedData,
  type NamespaceMigrateDeps,
  type NamespaceMigrateEvent,
  type NamespaceMigrateInput,
  type NamespaceMigratePreviewData,
  type NamespaceMigrateProgressData,
  type NamespaceMigrateWarningData,
  type SubdirPreview,
} from "./datastores/namespace_migrate.ts";
export {
  questPass,
  type QuestPassData,
  type QuestPassDeps,
  type QuestPassEvent,
} from "./quest/pass.ts";
export {
  createStartDeps,
  resolveStartWorkspacePath,
  type SignedInState,
  startAddTools,
  startBack,
  startCheckFolder,
  startCheckWorkspaceLocation,
  startChooseHarness,
  type StartContents,
  type StartDeps,
  type StartFolderCheck,
  type StartHarnessInfo,
  startImportWorkspace,
  startInspect,
  type StartInspection,
  startLaunch,
  type StartLaunchEvent,
  startListHarnesses,
  startListTasks,
  startListWorkspaces,
  type StartLocationCheck,
  startOpenAgent,
  startOpenWorkspace,
  startPickFolder,
  startPrepare,
  type StartPrepareEvent,
  type StartRepoOps,
  startResume,
  startSaveTask,
  type StartScreen,
  type StartSignals,
  startSignIn,
  type StartSignInEvent,
  type StartStatus,
  startStatus,
  type StartStatusEvent,
  type StartTaskSummary,
  type StartWorkspaceLocationInput,
  type StartWorkspaceSummary,
} from "./start/start.ts";
export {
  workspaceCreate,
  type WorkspaceCreateData,
  type WorkspaceCreateEvent,
} from "./workspace/create.ts";
export {
  createWorkspaceDeps,
  type WorkspaceDeps,
  type WorkspaceFolderState,
  type WorkspaceSummary,
} from "./workspace/deps.ts";
export {
  workspaceGet,
  type WorkspaceGetData,
  type WorkspaceGetEvent,
} from "./workspace/get.ts";
export {
  workspaceImport,
  type WorkspaceImportData,
  type WorkspaceImportEvent,
} from "./workspace/import.ts";
export {
  workspaceList,
  type WorkspaceListData,
  type WorkspaceListEvent,
} from "./workspace/list.ts";
export {
  workspaceRemove,
  type WorkspaceRemoveData,
  type WorkspaceRemoveEvent,
} from "./workspace/remove.ts";
export {
  MAX_WORKSPACE_PARENT_LENGTH,
  resolveChosenFolder,
} from "./workspace/workspace_store.ts";
