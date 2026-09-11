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
  resolveServerToken,
  resolveServeUrl,
  streamServerResponse,
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
  readonly data?: string;
  readonly events?: unknown[];
  readonly streaming?: boolean;
  readonly done?: boolean;
}

export const auditExportCommand = withRemoteOptions(
  new Command()
    .name("export")
    .description("Bulk export audit events for compliance")
    .example(
      "Export as JSON",
      "swamp audit export --server http://localhost:7443 --since 2026-09-01 --until 2026-09-08",
    )
    .example(
      "Export as CEF",
      "swamp audit export --server http://localhost:7443 --since 2026-09-01 --until 2026-09-08 --format cef",
    )
    .example(
      "Export to file",
      "swamp audit export --server http://localhost:7443 --since 2026-09-01 --until 2026-09-08 --output audit.csv --format csv",
    )
    .option("--since <date:string>", "Start time (ISO 8601)", {
      required: true,
    })
    .option("--until <date:string>", "End time (ISO 8601)", {
      required: true,
    })
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
    )
    .option("--resource <name:string>", "Filter by resource name"),
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

  const requestPayload = {
    type: "audit.export",
    payload: {
      from: options.since,
      to: options.until,
      format,
      principal: options.principal,
      category: options.category,
      action: options.action,
      outcome: options.outcome,
      resource: options.resource,
    },
  };

  const renderer = createAuditExportRenderer(ctx.outputMode);
  let totalCount = 0;
  let allData = "";
  let allEvents: unknown[] = [];
  let isFirstChunk = true;
  let outputFile: Deno.FsFile | undefined;

  try {
    if (options.output) {
      outputFile = await Deno.open(options.output, {
        write: true,
        create: true,
        truncate: true,
      });
    }

    const stream = streamServerResponse<AuditExportResponse>(
      { server, token },
      requestPayload,
    );

    for await (const chunk of stream) {
      if (chunk.done) {
        totalCount = chunk.count;
        break;
      }

      const chunkData = chunk.data ??
        (chunk.events ? JSON.stringify(chunk.events, null, 2) : "");

      if (outputFile) {
        const prefix = !isFirstChunk && format !== "json" ? "\n" : "";
        await outputFile.write(
          new TextEncoder().encode(prefix + chunkData),
        );
      } else {
        allData += (isFirstChunk ? "" : "\n") + chunkData;
        if (chunk.events) allEvents = allEvents.concat(chunk.events);
      }
      isFirstChunk = false;
    }
  } finally {
    if (outputFile) {
      outputFile.close();
    }
  }

  renderer.handlers().completed({
    kind: "completed",
    data: {
      format,
      count: totalCount,
      data: outputFile ? "" : allData,
      outputPath: options.output,
    },
  });
});
