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
import { UserError } from "../../domain/errors.ts";
import { createAuditExportRenderer } from "../../presentation/output/audit_export_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

interface AuditExportResponse {
  readonly format: string;
  readonly count: number;
  readonly truncated?: boolean;
  readonly data: string;
  readonly events?: unknown[];
}

export const auditExportCommand = withRemoteOptions(
  new Command()
    .name("export")
    .description("Bulk export audit events for compliance")
    .example(
      "Export as JSON",
      "swamp audit export --server http://localhost:7443 --from 2026-09-01 --to 2026-09-08",
    )
    .example(
      "Export as CEF",
      "swamp audit export --server http://localhost:7443 --from 2026-09-01 --to 2026-09-08 --format cef",
    )
    .example(
      "Export to file",
      "swamp audit export --server http://localhost:7443 --from 2026-09-01 --to 2026-09-08 --output audit.csv --format csv",
    )
    .option("--from <date:string>", "Start time (ISO 8601)", { required: true })
    .option("--to <date:string>", "End time (ISO 8601)", { required: true })
    .option(
      "--format <fmt:string>",
      "Output format: json, cef, csv [default: json]",
      { default: "json" },
    )
    .option("--output <path:string>", "Write output to file instead of stdout")
    .option("--principal <id:string>", "Filter by principal ID")
    .option(
      "--category <cat:string>",
      "Filter by audit category (auth, access, execution, secrets, admin, data, system)",
    )
    .option("--action <action:string>", "Filter by action")
    .option(
      "--outcome <outcome:string>",
      "Filter by outcome (success, failure, denied)",
    ),
).action(async function (options: AnyOptions) {
  const ctx = createContext(options as GlobalOptions, ["audit", "export"]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (!server) {
    throw new UserError(
      "The audit export command requires a running serve instance. Use --server to specify the URL.",
    );
  }

  const token = await resolveServerToken(
    server,
    options.token as string | undefined,
  );

  const format = options.format as string;
  if (!["json", "cef", "csv"].includes(format)) {
    throw new UserError(
      `Invalid format "${format}": expected one of json, cef, csv`,
    );
  }

  const response = await requestServerResponse<AuditExportResponse>(
    { server, token },
    {
      type: "audit.export",
      payload: {
        from: options.from,
        to: options.to,
        format,
        principal: options.principal,
        category: options.category,
        action: options.action,
        outcome: options.outcome,
      },
    },
  );

  const outputData = response.data ??
    (response.events ? JSON.stringify(response.events, null, 2) : "");

  if (options.output) {
    await Deno.writeTextFile(options.output, outputData);
  }

  const renderer = createAuditExportRenderer(ctx.outputMode);
  renderer.handlers().completed({
    kind: "completed",
    data: {
      format: response.format,
      count: response.count,
      truncated: response.truncated,
      data: outputData,
      outputPath: options.output,
    },
  });
});
