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

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { AuditReportResponse } from "../../serve/protocol.ts";
import { renderAuditReport } from "../../presentation/output/audit_report_output.ts";
import { UserError } from "../../domain/errors.ts";
import { COMPLIANCE_REPORTS } from "../../domain/serve_audit/audit_compliance_reports.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const REPORT_NAMES = COMPLIANCE_REPORTS.map((r) => r.name);

export const auditReportCommand = withRemoteOptions(
  new Command()
    .name("report")
    .description("Run an audit compliance report")
    .example(
      "Run access review",
      "swamp audit report access-review --server http://localhost:7443 --from 2026-09-01 --to 2026-09-10",
    )
    .example(
      "List available reports",
      "swamp audit report --list",
    )
    .arguments("[name:string]")
    .option("--list", "List available compliance reports")
    .option(
      "--from <date:string>",
      "Start date, e.g. 2026-09-01T00:00:00Z",
    )
    .option(
      "--to <date:string>",
      "End date, e.g. 2026-09-10T00:00:00Z",
    ),
).action(async function (options: AnyOptions, name?: string) {
  const ctx = createContext(options as GlobalOptions, ["audit", "report"]);

  if (options.list) {
    if (ctx.outputMode === "json") {
      console.log(
        JSON.stringify(
          COMPLIANCE_REPORTS.map((r) => ({
            name: r.name,
            description: r.description,
          })),
          null,
          2,
        ),
      );
    } else {
      for (const report of COMPLIANCE_REPORTS) {
        console.log(`  ${report.name.padEnd(20)} ${report.description}`);
      }
    }
    return;
  }

  if (!name) {
    throw new UserError(
      `Report name required. Available reports: ${REPORT_NAMES.join(", ")}`,
    );
  }

  if (!REPORT_NAMES.includes(name)) {
    throw new UserError(
      `Unknown report "${name}". Available reports: ${REPORT_NAMES.join(", ")}`,
    );
  }

  if (!options.from || !options.to) {
    throw new UserError(
      "Both --from and --to are required for compliance reports.",
    );
  }

  const server = resolveServeUrl(options.server as string | undefined);
  if (!server) {
    throw new UserError(
      "The audit report command requires a running serve instance. Use --server to specify the URL.",
    );
  }

  const token = await resolveServerToken(
    server,
    options.token as string | undefined,
  );

  const response = await requestServerResponse<AuditReportResponse>(
    { server, token },
    {
      type: "audit.report",
      payload: {
        name,
        from: options.from,
        to: options.to,
      },
    },
  );

  renderAuditReport(response, ctx.outputMode);
});
