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
  subscribeServerEvents,
  withRemoteOptions,
} from "../remote_run.ts";
import type { AuditQueryResponse } from "../../serve/protocol.ts";
import {
  renderAuditEvent,
  renderAuditLog,
  renderAuditLogHeader,
} from "../../presentation/output/audit_log_output.ts";
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
    .example(
      "Follow live",
      "swamp audit log --server http://localhost:7443 --follow",
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
    .option(
      "--category <cat:string>",
      "Filter by audit category (auth, access, execution, secrets, admin, data, system)",
    )
    .option("--action <action:string>", "Filter by action")
    .option(
      "--outcome <outcome:string>",
      "Filter by outcome (success, failure, denied)",
    )
    .option(
      "--cursor <token:string>",
      "Pagination cursor from a previous query",
    )
    .option("--limit <count:integer>", "Max events to return [default: 100]", {
      default: 100,
    })
    .option(
      "--follow",
      "Stream new audit events in real-time after the initial query",
    ),
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
        cursor: options.cursor,
      },
    },
  );

  if (!options.follow) {
    renderAuditLog(response, ctx.outputMode);
    return;
  }

  renderAuditLogHeader(ctx.outputMode);
  for (const event of response.events) {
    renderAuditEvent(event as Record<string, string>, ctx.outputMode);
  }

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  Deno.addSignalListener("SIGINT", onSignal);

  try {
    const filter: Record<string, unknown> = {};
    if (options.category) filter.categories = [options.category];
    if (options.principal) filter.principals = [options.principal];
    if (options.action) filter.actions = [options.action];
    if (options.outcome) filter.outcomes = [options.outcome];

    const stream = subscribeServerEvents(
      { server, token, signal: ac.signal },
      {
        type: "audit.subscribe",
        payload: Object.keys(filter).length > 0 ? filter : undefined,
      },
    );

    for await (const event of stream) {
      renderAuditEvent(event as Record<string, string>, ctx.outputMode);
    }
  } finally {
    Deno.removeSignalListener("SIGINT", onSignal);
  }
});
