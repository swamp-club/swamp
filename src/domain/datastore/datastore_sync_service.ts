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
 * Interface for datastore synchronization services.
 *
 * Extension datastores implement this interface to provide
 * bidirectional sync between a local cache and a remote backend.
 */
export interface DatastoreSyncService {
  /** Pull changed files from the remote datastore to the local cache. */
  pullChanged(): Promise<void>;
  /** Push changed files from the local cache to the remote datastore. */
  pushChanged(): Promise<void>;
}
