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

import type { EventHandlers, ReportGetEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { renderMarkdownToTerminal } from "../markdown_renderer.ts";

class LogReportGetRenderer implements Renderer<ReportGetEvent> {
  handlers(): EventHandlers<ReportGetEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const r = e.data;
        const separator = "\u2500".repeat(60);
        const source = r.workflowName
          ? `Workflow: ${r.workflowName}`
          : `Model: ${r.modelName} (${r.modelType})`;
        const varySuffixLabel = r.varySuffix
          ? `  |  Variant: ${r.varySuffix}`
          : "";
        writeOutput(
          `${separator}\n  ${r.reportName}  |  ${source}  |  Scope: ${r.reportScope}${varySuffixLabel}  |  v${r.version}  |  ${r.createdAt}\n${separator}`,
        );
        writeOutput(renderMarkdownToTerminal(r.markdown));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonReportGetRenderer implements Renderer<ReportGetEvent> {
  handlers(): EventHandlers<ReportGetEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createReportGetRenderer(
  mode: OutputMode,
): Renderer<ReportGetEvent> {
  switch (mode) {
    case "json":
      return new JsonReportGetRenderer();
    case "log":
      return new LogReportGetRenderer();
  }
}
