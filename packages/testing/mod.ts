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

export { createModelTestContext } from "./test_context.ts";

export type {
  CapturedLog,
  ModelTestContextOptions,
  ModelTestContextResult,
  WrittenFile,
  WrittenResource,
} from "./test_context.ts";

export type {
  DataHandle,
  DataHandleMetadata,
  DataWriter,
  DefinitionInfo,
  GarbageCollectionPolicy,
  Lifetime,
  LogLevel,
  MethodContext,
  MethodExecutionEvent,
  MethodResult,
  OwnerDefinition,
} from "./types.ts";

// these types let extension authors resolve TS7006 (implicit any on execute
// parameters) under strict mode when a test file imports the sibling model
// source.

export { defineBehavior, defineModel } from "./model_definition_types.ts";

export type {
  CheckDefinition,
  CheckResult,
  FileOutputSpec,
  MethodDefinition,
  ModelDefinition,
  ResourceOutputSpec,
  VersionUpgrade,
} from "./model_definition_types.ts";

export { createVaultTestContext } from "./vault_test_context.ts";

export type {
  VaultExistenceTestContextResult,
  VaultOperation,
  VaultTestContextOptions,
  VaultTestContextResult,
} from "./vault_test_context.ts";

export {
  VaultAnnotation,
  type VaultAnnotationData,
  type VaultAnnotationProvider,
  type VaultExistenceProvider,
  type VaultProvider,
  type VaultPutOptions,
} from "./vault_types.ts";

export {
  assertVaultAnnotationConformance,
  assertVaultAnnotationExportConformance,
  assertVaultConformance,
  assertVaultExistenceConformance,
  assertVaultExistenceExportConformance,
  assertVaultExportConformance,
} from "./vault_conformance.ts";

export type {
  VaultAnnotationConformanceOptions,
  VaultAnnotationExport,
  VaultAnnotationExportConformanceOptions,
  VaultConformanceOptions,
  VaultExistenceConformanceOptions,
  VaultExistenceExport,
  VaultExistenceExportConformanceOptions,
  VaultExport,
  VaultExportConformanceOptions,
} from "./vault_conformance.ts";

export type {
  WebhookHandler,
  WebhookPayload,
  WebhookResponse,
} from "./webhook_types.ts";

export { assertWebhookExportConformance } from "./webhook_conformance.ts";

export type {
  WebhookExport,
  WebhookExportConformanceOptions,
  WebhookRequestFixture,
} from "./webhook_conformance.ts";

export { createDatastoreTestContext } from "./datastore_test_context.ts";

export type {
  DatastoreTestContextOptions,
  DatastoreTestContextResult,
  LockOperation,
  SyncOperation,
} from "./datastore_test_context.ts";

export type {
  ControlPlaneReadOptions,
  ControlPlaneStore,
  DatastoreControlPlaneStore,
  DatastoreHealthResult,
  DatastoreProvider,
  DatastoreStorage,
  DatastoreSyncOptions,
  DatastoreSyncService,
  DatastoreVerifier,
  DistributedLock,
  LockInfo,
  LockOptions,
  RepairUnpushedFilesOptions,
  ReplicaPathStore,
  StorageCapabilities,
  StoredChunk,
  SyncCapabilities,
  SyncContext,
  UnpushedFilesSummary,
  V3ReplicaTarget,
  WritableDatastoreControlPlaneStore,
} from "./datastore_types.ts";

export {
  assertDatastoreExportConformance,
  assertLockConformance,
  assertLockTimeoutConformance,
  assertSyncServiceConformance,
  assertSyncServiceRoundTripConformance,
  assertVerifierConformance,
} from "./datastore_conformance.ts";

export type {
  DatastoreExport,
  DatastoreExportConformanceOptions,
  SyncServiceConformanceOptions,
  SyncServiceRoundTripFactory,
  SyncServiceRoundTripFixture,
  SyncServiceRoundTripInstance,
  SyncServiceRoundTripOptions,
  SyncServiceRoundTripResult,
} from "./datastore_conformance.ts";

export {
  assertControlPlaneStoreConformance,
  assertDatastoreControlPlaneStoreConformance,
  assertWritableDatastoreControlPlaneStoreConformance,
  createInMemoryControlPlaneStore,
} from "./control_plane_conformance.ts";

export type {
  ControlPlaneStoreConformanceOptions,
  DatastoreControlPlaneStoreConformanceOptions,
  NamespacedSyncFixture,
  WritableDatastoreControlPlaneStoreConformanceOptions,
  WritableDatastoreControlPlaneStoreConformanceResult,
} from "./control_plane_conformance.ts";

export { assertStorageConformance } from "./storage_conformance.ts";

export type { StorageConformanceOptions } from "./storage_conformance.ts";

export {
  assertReplicaTargetConformance,
  replicaTargetProblem,
} from "./replica_target_conformance.ts";

export type { ReplicaTargetConformanceOptions } from "./replica_target_conformance.ts";

export {
  assertReplicaPathConformance,
  replicaPathFenceProblem,
} from "./replica_path_conformance.ts";

export type { ReplicaPathConformanceOptions } from "./replica_path_conformance.ts";

export {
  createInMemoryRemote,
  EXTENSION_2026_10_01_SEMANTICS,
  EXTENSION_2026_10_20_SEMANTICS,
  EXTENSION_SEMANTICS,
  LEGACY_EXTENSION_SEMANTICS,
} from "./in_memory_remote.ts";

export type {
  ConnectOptions,
  FailNextOptions,
  InMemoryControlPlaneRead,
  InMemoryPushManifest,
  InMemoryRemote,
  InMemoryRemoteFailure,
  InMemoryRemoteOpRecord,
  InMemoryRemoteOptions,
  InMemoryRemoteSemantics,
  InMemorySyncService,
} from "./in_memory_remote.ts";

export { createRecordingSyncService } from "./recording_sync_service.ts";

export type {
  RecordedSyncEvent,
  RecordingSyncService,
} from "./recording_sync_service.ts";

export { createReportTestContext } from "./report_test_context.ts";

export type {
  CapturedReportLog,
  MethodReportTestContextOptions,
  ModelReportTestContextOptions,
  ReportTestContextOptions,
  ReportTestContextResult,
  StoredDataArtifact,
  WorkflowReportTestContextOptions,
} from "./report_test_context.ts";

export type {
  MethodReportContext,
  ModelReportContext,
  ReportContext,
  ReportResult,
  ReportScope,
  TestData,
  TestDataRepository,
  TestDefinition,
  TestDefinitionRepository,
  WorkflowReportContext,
} from "./report_types.ts";

export { withMockedFetch } from "./mock_fetch.ts";

export type {
  CapturedFetchCall,
  FetchHandler,
  MockFetchResult,
} from "./mock_fetch.ts";

export { withMockedCommand } from "./mock_command.ts";

export type {
  CapturedCommandCall,
  CommandHandler,
  CommandOutput,
  MockCommandResult,
} from "./mock_command.ts";

export { waitFor } from "./wait_for.ts";

export type { WaitForOptions } from "./wait_for.ts";
