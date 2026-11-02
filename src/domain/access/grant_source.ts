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

import { z } from "zod";

const FIXED_SOURCES = ["method", "config"] as const;

const PREFIXED_SOURCES = ["file:", "extension:"] as const;

export const GrantSourceSchema = z.string().min(1).refine(
  (value) => {
    if ((FIXED_SOURCES as readonly string[]).includes(value)) {
      return true;
    }
    return PREFIXED_SOURCES.some((prefix) => value.startsWith(prefix)) &&
      !PREFIXED_SOURCES.some((prefix) => value === prefix);
  },
  {
    message:
      'Grant source must be "method", "config", "file:<filename>", or "extension:<name>"',
  },
);

export type GrantSource = z.infer<typeof GrantSourceSchema>;

export function parseGrantSource(value: string): GrantSource {
  const result = GrantSourceSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid grant source "${value}": must be "method", "config", "file:<filename>", or "extension:<name>"`,
    );
  }
  return result.data;
}

export function isFileSource(source: string): boolean {
  return source.startsWith("file:");
}

export function parseFileSourceFilename(source: string): string {
  if (!isFileSource(source)) {
    throw new Error(
      `Cannot parse filename from non-file source "${source}"`,
    );
  }
  return source.slice("file:".length);
}

// sources are named independent of mount path: instances sharing a datastore
// may mount the same files differently, and an absolute path would make each
// revoke the other's grants; neither form can equal a repo file name
const GRANTS_DIR_SOURCE_PREFIX = "grants-dir/";

export function grantsDirSourceName(basename: string): string {
  return `${GRANTS_DIR_SOURCE_PREFIX}${basename}`;
}

export const GRANTS_FILE_SOURCE_NAME = "grants-file";

export function isGrantsDirSourceName(filename: string): boolean {
  return filename.startsWith(GRANTS_DIR_SOURCE_PREFIX);
}
