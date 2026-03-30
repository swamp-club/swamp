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
 * @systeminit/swamp-testing — Test utilities for swamp extensions.
 *
 * Provides test factories and conformance suites for all extension types:
 * models, vaults, datastores, execution drivers, and reports.
 *
 * - **Factories** create in-memory fakes for unit testing without infrastructure
 * - **Conformance suites** verify that real implementations satisfy their contracts
 *
 * @module
 */

// --- Models ---

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

// --- Vaults ---

export { createVaultTestContext } from "./vault_test_context.ts";

export type {
  VaultOperation,
  VaultTestContextOptions,
  VaultTestContextResult,
} from "./vault_test_context.ts";

export type { VaultProvider } from "./vault_types.ts";

export {
  assertVaultConformance,
  assertVaultExportConformance,
} from "./vault_conformance.ts";

export type {
  VaultConformanceOptions,
  VaultExport,
  VaultExportConformanceOptions,
} from "./vault_conformance.ts";

// --- Datastores ---

export { createDatastoreTestContext } from "./datastore_test_context.ts";

export type {
  DatastoreTestContextOptions,
  DatastoreTestContextResult,
  LockOperation,
  SyncOperation,
} from "./datastore_test_context.ts";

export type {
  DatastoreHealthResult,
  DatastoreProvider,
  DatastoreSyncService,
  DatastoreVerifier,
  DistributedLock,
  LockInfo,
  LockOptions,
} from "./datastore_types.ts";

export {
  assertDatastoreExportConformance,
  assertLockConformance,
  assertVerifierConformance,
} from "./datastore_conformance.ts";

export type {
  DatastoreExport,
  DatastoreExportConformanceOptions,
} from "./datastore_conformance.ts";

// --- Drivers ---

export { createDriverTestContext } from "./driver_test_context.ts";

export type {
  CapturedDriverLog,
  CapturedResourceEvent,
  DriverTestContextResult,
  TestExecutionRequestOptions,
} from "./driver_test_context.ts";

export type {
  DriverOutput,
  ExecutionCallbacks,
  ExecutionDriver,
  ExecutionRequest,
  ExecutionResult,
} from "./driver_types.ts";

// --- Reports ---

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
