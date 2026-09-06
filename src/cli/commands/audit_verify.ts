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
import type { AuditVerifyResponse } from "../../serve/protocol.ts";
import { renderAuditVerify } from "../../presentation/output/audit_verify_output.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const auditVerifyCommand = withRemoteOptions(
  new Command()
    .name("verify")
    .description("Verify audit log chain integrity")
    .example(
      "Verify last 24 hours",
      "swamp audit verify --server http://localhost:7443",
    )
    .example(
      "Verify a time range",
      "swamp audit verify --server http://localhost:7443 --since 2026-09-01T00:00:00Z --until 2026-09-02T00:00:00Z",
    )
    .option(
      "--since <date:string>",
      "Start time, e.g. 2026-09-01T00:00:00Z [default: 24 hours ago]",
    )
    .option(
      "--until <date:string>",
      "End time, e.g. 2026-09-02T00:00:00Z [default: now]",
    ),
).action(async function (options: AnyOptions) {
  const ctx = createContext(options as GlobalOptions, ["audit", "verify"]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (!server) {
    throw new UserError(
      "The audit verify command requires a running serve instance. Use --server to specify the URL.",
    );
  }

  const token = await resolveServerToken(
    server,
    options.token as string | undefined,
  );

  const response = await requestServerResponse<AuditVerifyResponse>(
    { server, token },
    {
      type: "audit.verify",
      payload: {
        since: options.since,
        until: options.until,
      },
    },
  );

  renderAuditVerify(response, ctx.outputMode);

  if (!response.valid) {
    Deno.exitCode = 1;
  }
});
