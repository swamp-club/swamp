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
import type { AuditQueryResponse } from "../../serve/protocol.ts";
import { renderAuditLog } from "../../presentation/output/audit_log_output.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const auditLogCommand = withRemoteOptions(
  new Command()
    .name("log")
    .description("Query the serve audit log")
    .example("Last 24 hours", "swamp audit log --server http://localhost:7443")
    .example(
      "Filter by category",
      "swamp audit log --server http://localhost:7443 --category secrets",
    )
    .example(
      "Filter by outcome",
      "swamp audit log --server http://localhost:7443 --outcome denied",
    )
    .option(
      "--since <date:string>",
      "Start time, e.g. 2026-09-01T00:00:00Z [default: 24 hours ago]",
    )
    .option(
      "--until <date:string>",
      "End time, e.g. 2026-09-02T00:00:00Z [default: now]",
    )
    .option("--principal <id:string>", "Filter by principal ID")
    .option("--category <cat:string>", "Filter by audit category")
    .option("--action <action:string>", "Filter by action")
    .option(
      "--outcome <outcome:string>",
      "Filter by outcome (success, failure, denied)",
    )
    .option("--limit <count:integer>", "Max events to return [default: 100]", {
      default: 100,
    }),
).action(async function (options: AnyOptions) {
  const ctx = createContext(options as GlobalOptions, ["audit", "log"]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (!server) {
    throw new UserError(
      "The audit log command requires a running serve instance. Use --server to specify the URL.",
    );
  }

  const token = await resolveServerToken(
    server,
    options.token as string | undefined,
  );

  const response = await requestServerResponse<AuditQueryResponse>(
    { server, token },
    {
      type: "audit.query",
      payload: {
        since: options.since,
        until: options.until,
        principal: options.principal,
        category: options.category,
        action: options.action,
        outcome: options.outcome,
        limit: options.limit,
      },
    },
  );

  renderAuditLog(response, ctx.outputMode);
});
