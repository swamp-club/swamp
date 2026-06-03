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

import type { ReportDefinition } from "../../domain/reports/report.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound } from "../errors.ts";
import type { ReportDescribeEvent } from "./report_views.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Dependencies for the report describe operation.
 */
export interface ReportDescribeDeps {
  getReport: (name: string) => Promise<ReportDefinition | undefined>;
}

/** Wires real infrastructure into ReportDescribeDeps. */
export async function createReportDescribeDeps(): Promise<ReportDescribeDeps> {
  await reportRegistry.ensureLoaded();
  return {
    getReport: async (name) => {
      await reportRegistry.ensureTypeLoaded(name);
      return reportRegistry.get(name);
    },
  };
}

/**
 * Looks up a report definition from the registry and yields its metadata.
 */
export async function* reportDescribe(
  _ctx: LibSwampContext,
  deps: ReportDescribeDeps,
  reportName: string,
): AsyncGenerator<ReportDescribeEvent> {
  yield* withGeneratorSpan(
    "swamp.report.describe",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const report = await deps.getReport(reportName);
      if (!report) {
        yield { kind: "error", error: notFound("Report", reportName) };
        return;
      }

      yield {
        kind: "completed",
        data: {
          name: reportName,
          description: report.description,
          scope: report.scope,
          labels: report.labels ?? [],
        },
      };
    })(),
  );
}
