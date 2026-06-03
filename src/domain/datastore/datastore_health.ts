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

/**
 * Datastore health check types and interfaces.
 *
 * Every CLI command that calls `requireInitializedRepo()` verifies
 * the configured datastore is accessible before proceeding.
 */

/**
 * Result of a datastore health check.
 */
export interface DatastoreHealthResult {
  /** Whether the datastore is healthy and accessible */
  readonly healthy: boolean;
  /** Human-readable status message */
  readonly message: string;
  /** Latency of the health check in milliseconds */
  readonly latencyMs: number;
  /** Datastore type that was checked */
  readonly datastoreType: string;
  /** Additional details (e.g., path, bucket name) */
  readonly details?: Record<string, string>;
}

/**
 * Interface for verifying datastore accessibility.
 */
export interface DatastoreVerifier {
  /**
   * Verifies the datastore is accessible and writable.
   *
   * - Filesystem: checks directory exists and is writable
   * - S3: issues a HeadBucket request
   *
   * @returns Health check result
   */
  verify(): Promise<DatastoreHealthResult>;
}
