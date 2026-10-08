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
  ALWAYS_LOCAL_SUBDIRS,
  classifyInRepoConfig,
  type ConfigTierConflict,
  type ConfigTierMerge,
  type CustomDatastoreConfig,
  type DatastoreConfig,
  type DatastoreConfigData,
  DEFAULT_DATASTORE_SUBDIRS,
  DEFAULT_SYNC_TIMEOUT_MS,
  type FilesystemDatastoreConfig,
  getDatastoreDirectories,
  inRepoConfigMigrationSkips,
  type InRepoConfigRole,
  isAlwaysLocal,
  isCustomDatastoreConfig,
  mergeSetupDatastoreBlock,
  planConfigTierMerge,
  PULLED_EXTENSIONS_SUBDIR,
  resolveSyncTimeoutMs,
  SETUP_PRESERVED_DATASTORE_KEYS,
  SYNC_TIMEOUT_ENV_VAR,
} from "./datastore_config.ts";

export {
  isShareableDatastore,
  type LockScope,
  SLOW_LOCK_THRESHOLD_MS,
  type SlowLockAdvice,
  slowLockAdvice,
  type SlowLockAdviceInput,
} from "./slow_lock_advice.ts";

export {
  compilePatterns,
  globToRegExp,
  isExcluded,
  isExcludedCompiled,
} from "./datastore_pattern_matcher.ts";

export {
  type DatastoreHealthResult,
  type DatastoreVerifier,
} from "./datastore_health.ts";

export { type DatastorePathResolver } from "./datastore_path_resolver.ts";

export { type ControlPlaneStore } from "./control_plane_store.ts";

export {
  type CatalogExportEntry,
  type CatalogExportRow,
  type DatastoreSyncOptions,
  type DatastoreSyncService,
  type MarkDirtyHook,
  type PushManifest,
  type PushPreviewSummary,
  type SyncCapabilities,
  type SyncContext,
  type SyncDirection,
  SyncTimeoutError,
} from "./datastore_sync_service.ts";

export { type DatastoreProvider } from "./datastore_provider.ts";

export { type StagedChange, type UnitOfWork } from "./unit_of_work.ts";

export {
  type DatastoreTypeInfo,
  DatastoreTypeRegistry,
  datastoreTypeRegistry,
} from "./datastore_type_registry.ts";

export { getDatastoreType, getDatastoreTypes } from "./datastore_types.ts";

export { ExtensionLoader } from "../extensions/extension_loader.ts";
export { datastoreKindAdapter } from "../extensions/datastore_kind_adapter.ts";

export {
  assertSupportedDatastoreFormat,
  DATASTORE_FORMAT_MARKER_FILE,
  DATASTORE_FORMAT_MARKER_INVALID_CODE,
  DATASTORE_FORMAT_MARKER_KEY,
  DATASTORE_FORMAT_UNSUPPORTED_CODE,
  type DatastoreFormatDecision,
  type DatastoreFormatMarker,
  type DatastoreFormatMarkerRead,
  InvalidDatastoreFormatMarkerError,
  parseDatastoreFormatMarker,
  SUPPORTED_DATASTORE_FORMATS,
  UnsupportedDatastoreFormatError,
} from "./datastore_format.ts";
