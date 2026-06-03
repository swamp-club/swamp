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

import { join } from "@std/path";

/**
 * Date-to-path derivation for the audit JSONL store.
 *
 * Both the JSONL writer in infrastructure and the preflight smoke-test in
 * `doctor/checks/recording_smoke_test.ts` consume these helpers. A single
 * source of truth prevents the writer and reader from silently drifting on
 * the filename format.
 */

const AUDIT_FILENAME_PREFIX = "commands-";
const AUDIT_FILENAME_SUFFIX = ".jsonl";

/** Matches audit JSONL filenames and captures the `YYYY-MM-DD` date. */
export const AUDIT_FILENAME_PATTERN = /^commands-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Formats a `YYYY-MM-DD` date string as the audit filename for that day. */
export function auditFilename(date: string): string {
  return `${AUDIT_FILENAME_PREFIX}${date}${AUDIT_FILENAME_SUFFIX}`;
}

/** Extracts the `YYYY-MM-DD` date portion of an ISO-8601 timestamp. */
export function datePartOfIsoTimestamp(iso: string): string {
  return iso.split("T")[0];
}

/** Returns the audit filename corresponding to an ISO-8601 timestamp. */
export function auditFilenameForTimestamp(isoTimestamp: string): string {
  return auditFilename(datePartOfIsoTimestamp(isoTimestamp));
}

/** Returns the absolute path to the audit JSONL file for a given timestamp. */
export function auditFilePathForTimestamp(
  auditDir: string,
  isoTimestamp: string,
): string {
  return join(auditDir, auditFilenameForTimestamp(isoTimestamp));
}

/** Returns the absolute path to today's audit JSONL file. */
export function todaysAuditFilePath(auditDir: string): string {
  return auditFilePathForTimestamp(auditDir, new Date().toISOString());
}
