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
  QualityCheckResult,
  QualityIssue,
} from "../../domain/extensions/extension_quality_checker.ts";

const logger = getSwampLogger(["extension", "fmt"]);

/** Data for fmt fix results. */
export interface ExtensionFmtData {
  fileCount: number;
  fmtOutput: string;
  lintOutput: string;
  remainingIssues: QualityIssue[];
}

/**
 * Renders the result of auto-fixing formatting and lint issues.
 */
export function renderExtensionFmt(
  data: ExtensionFmtData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(
      {
        status: data.remainingIssues.length > 0 ? "partial" : "fixed",
        fileCount: data.fileCount,
        fmtOutput: data.fmtOutput,
        lintOutput: data.lintOutput,
        remainingIssues: data.remainingIssues,
      },
      null,
      2,
    ));
  } else {
    logger.info`Formatted ${data.fileCount} TypeScript files.`;
    if (data.fmtOutput) {
      logger.info`${data.fmtOutput}`;
    }
    if (data.lintOutput) {
      logger.info`${data.lintOutput}`;
    }
    if (data.remainingIssues.length > 0) {
      logger.error`Remaining issues that could not be auto-fixed:`;
      for (const issue of data.remainingIssues) {
        const label = issue.check === "fmt" ? "Formatting" : "Lint";
        logger.error`  ${label} issues:`;
        logger.error`${issue.output}`;
      }
    }
  }
}

/**
 * Renders the result of a check-only run (same as push gate).
 */
export function renderExtensionFmtCheck(
  result: QualityCheckResult,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(
      {
        status: result.passed ? "passed" : "failed",
        issues: result.issues,
      },
      null,
      2,
    ));
  } else {
    if (result.passed) {
      logger.info("All quality checks passed.");
    } else {
      logger.error`Quality checks failed:`;
      for (const issue of result.issues) {
        const label = issue.check === "fmt" ? "Formatting" : "Lint";
        logger.error`  ${label} issues:`;
        logger.error`${issue.output}`;
      }
    }
  }
}
