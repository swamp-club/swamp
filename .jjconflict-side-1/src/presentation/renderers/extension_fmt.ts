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

import type { EventHandlers, ExtensionFmtEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

/** Renderer interface that also exposes pass/fail state for the CLI. */
export interface ExtensionFmtRenderer extends Renderer<ExtensionFmtEvent> {
  passed(): boolean;
  failureMessage(): string;
}

class LogExtensionFmtRenderer implements ExtensionFmtRenderer {
  private _passed = true;
  private _failureMessage = "";

  passed(): boolean {
    return this._passed;
  }

  failureMessage(): string {
    return this._failureMessage;
  }

  handlers(): EventHandlers<ExtensionFmtEvent> {
    const logger = getSwampLogger(["extension", "fmt"]);
    return {
      no_files: () => {
        logger.info("No TypeScript files to check.");
      },
      completed: (e) => {
        const data = e.data;
        if (data.mode === "check") {
          if (data.passed) {
            logger.info("All quality checks passed.");
          } else {
            this._passed = false;
            this._failureMessage =
              "Quality checks failed. Run 'swamp extension fmt <manifest-path>' to fix.";
            logger.error`Quality checks failed:`;
            for (const issue of data.issues) {
              const label = issue.check === "fmt" ? "Formatting" : "Lint";
              logger.error`  ${label} issues:`;
              logger.error`${issue.output}`;
            }
          }
        } else {
          // fix mode
          logger.info`Formatted ${data.fileCount} TypeScript files.`;
          if (data.fmtOutput) logger.info`${data.fmtOutput}`;
          if (data.lintOutput) logger.info`${data.lintOutput}`;
          if (data.remainingIssues.length > 0) {
            this._passed = false;
            this._failureMessage =
              "Some issues could not be auto-fixed. See above for details.";
            logger.error`Remaining issues that could not be auto-fixed:`;
            for (const issue of data.remainingIssues) {
              const label = issue.check === "fmt" ? "Formatting" : "Lint";
              logger.error`  ${label} issues:`;
              logger.error`${issue.output}`;
            }
          }
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonExtensionFmtRenderer implements ExtensionFmtRenderer {
  private _passed = true;
  private _failureMessage = "";

  passed(): boolean {
    return this._passed;
  }

  failureMessage(): string {
    return this._failureMessage;
  }

  handlers(): EventHandlers<ExtensionFmtEvent> {
    return {
      no_files: () => {
        console.log(
          JSON.stringify({ status: "passed", fileCount: 0 }, null, 2),
        );
      },
      completed: (e) => {
        const data = e.data;
        if (data.mode === "check") {
          if (!data.passed) {
            this._passed = false;
            this._failureMessage =
              "Quality checks failed. Run 'swamp extension fmt <manifest-path>' to fix.";
          }
          console.log(JSON.stringify(
            {
              status: data.passed ? "passed" : "failed",
              issues: data.issues,
            },
            null,
            2,
          ));
        } else {
          if (!data.passed) {
            this._passed = false;
            this._failureMessage =
              "Some issues could not be auto-fixed. See above for details.";
          }
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
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionFmtRenderer(
  mode: OutputMode,
): ExtensionFmtRenderer {
  switch (mode) {
    case "json":
      return new JsonExtensionFmtRenderer();
    case "log":
      return new LogExtensionFmtRenderer();
  }
}
