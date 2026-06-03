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

/**
 * Metadata about fetched swamp source code.
 * Stored as .swamp-source-meta.json in the source directory.
 */
export interface SourceMetadata {
  /** Version tag or branch name (e.g., "v1.2.3" or "main") */
  version: string;
  /** Absolute path to the extracted source directory */
  path: string;
  /** Number of files in the extracted source */
  fileCount: number;
  /** ISO timestamp when the source was fetched */
  fetchedAt: string;
}

/**
 * Zod schema for validating SourceMetadata from JSON.
 */
export const SourceMetadataSchema = z.object({
  version: z.string(),
  path: z.string(),
  fileCount: z.number().int().nonnegative(),
  fetchedAt: z.string().datetime(),
});
