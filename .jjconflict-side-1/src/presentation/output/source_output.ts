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

import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../logging.ts";
import type {
  SourceCleanResult,
  SourceFetchResult,
  SourceInfoResult,
} from "../../domain/source/mod.ts";

const logger = getSwampLogger(["source"]);

/**
 * Data for source fetch output.
 */
export interface SourceFetchData {
  status: "fetched" | "already_fetched";
  version: string;
  path: string;
  fileCount: number;
  fetchedAt: string;
  previousVersion?: string;
}

/**
 * Data for source path output.
 */
export interface SourcePathData {
  status: "found" | "not_found";
  version?: string;
  path?: string;
  fileCount?: number;
  fetchedAt?: string;
}

/**
 * Data for source clean output.
 */
export interface SourceCleanData {
  status: "cleaned" | "not_found";
  path: string;
}

/**
 * Renders the source fetch result.
 */
export function renderSourceFetch(
  result: SourceFetchResult,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.status === "already_fetched") {
      logger.info`Source already fetched: ${result.version}`;
      logger.info`Path: ${result.path}`;
      logger.info`Files: ${result.fileCount}`;
    } else {
      if (result.previousVersion) {
        logger
          .info`Replaced version ${result.previousVersion} with ${result.version}`;
      } else {
        logger.info`Fetched source: ${result.version}`;
      }
      logger.info`Path: ${result.path}`;
      logger.info`Files: ${result.fileCount}`;
    }
  }
}

/**
 * Renders the source path/info result.
 */
export function renderSourcePath(
  result: SourceInfoResult,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.status === "not_found") {
      logger.info("No source fetched. Run `swamp source fetch` first.");
    } else {
      logger.info`Version: ${result.version}`;
      logger.info`Path: ${result.path}`;
      logger.info`Files: ${result.fileCount}`;
      logger.info`Fetched: ${result.fetchedAt}`;
    }
  }
}

/**
 * Renders the source clean result.
 */
export function renderSourceClean(
  result: SourceCleanResult,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.status === "not_found") {
      logger.info`No source to clean at ${result.path}`;
    } else {
      logger.info`Cleaned source at ${result.path}`;
    }
  }
}
