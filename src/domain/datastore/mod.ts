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

export {
  ALWAYS_LOCAL_SUBDIRS,
  type CustomDatastoreConfig,
  type DatastoreConfig,
  type DatastoreConfigData,
  DEFAULT_DATASTORE_SUBDIRS,
  type FilesystemDatastoreConfig,
  getDatastoreDirectories,
  isAlwaysLocal,
  isCustomDatastoreConfig,
  type S3DatastoreConfig,
} from "./datastore_config.ts";

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

export { type DatastoreSyncService } from "./datastore_sync_service.ts";

export { type DatastoreProvider } from "./datastore_provider.ts";

export {
  type DatastoreTypeInfo,
  DatastoreTypeRegistry,
  datastoreTypeRegistry,
} from "./datastore_type_registry.ts";

export { getDatastoreType, getDatastoreTypes } from "./datastore_types.ts";

export {
  type DatastoreLoadResult,
  UserDatastoreLoader,
} from "./user_datastore_loader.ts";
