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

import { assertEquals } from "@std/assert";
import { TelemetryService } from "../domain/telemetry/telemetry_service.ts";
import type { TelemetryEntry } from "../domain/telemetry/telemetry_entry.ts";
import type { TelemetryRepository } from "../domain/telemetry/repositories.ts";
import {
  clearActiveTelemetryService,
  setActiveTelemetryService,
} from "../cli/telemetry_integration.ts";
import { sendError } from "./handlers/shared.ts";
import {
  httpControlOutcome,
  recordControl,
  workflowControlActionOf,
} from "./control_telemetry.ts";

function socket(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send() {},
  } as unknown as WebSocket;
}

async function recorded(
  fn: () => Promise<void>,
): Promise<ReturnType<TelemetryEntry["toData"]>[]> {
  const saved: TelemetryEntry[] = [];
  setActiveTelemetryService(
    new TelemetryService(
      {
        save: (entry: TelemetryEntry) => {
          saved.push(entry);
          return Promise.resolve();
        },
      } as unknown as TelemetryRepository,
      "1.0.0",
    ),
  );
  try {
    await fn();
  } finally {
    clearActiveTelemetryService();
  }
  return saved.map((entry) => entry.toData());
}

Deno.test("recordControl: the first error reply is the outcome, a server failure is an error, and a discard sends nothing", async () => {
  const sent = await recorded(async () => {
    const ws = socket();
    const refused = recordControl(ws, "r1", "approve", {});
    sendError(ws, "r1", "unauthorized", "Access denied: user:x");
    sendError(ws, "r1", "internal_error", "later");
    await refused.settle();

    const failed = recordControl(ws, "r2", "reject", {});
    sendError(ws, "r2", "workflow_reject_failed", "boom");
    await failed.settle();

    const threw = recordControl(ws, "r3", "resume", {});
    await threw.fail();

    const answered = recordControl(ws, "r4", "signal", {});
    sendError(ws, "other", "unauthorized", "not this request");
    await answered.settle();

    const forwarded = recordControl(ws, "r5", "cancel", {});
    forwarded.discard();
    await forwarded.settle();
  });

  assertEquals(
    sent.map((data) => [data.invocation.subcommand, data.result]),
    [
      ["approve", {
        status: "user_error",
        errorType: "unauthorized",
        exitCode: 1,
      }],
      ["reject", {
        status: "error",
        errorType: "workflow_reject_failed",
        exitCode: 1,
      }],
      ["resume", { status: "error", errorType: "internal", exitCode: 1 }],
      ["signal", { status: "success", exitCode: 0 }],
    ],
  );
});

Deno.test("httpControlOutcome: reads the outcome from the HTTP status and keeps a count", () => {
  assertEquals(httpControlOutcome(200, 4), {
    status: "success",
    cancelledCount: 4,
  });
  assertEquals(httpControlOutcome(403), {
    status: "user_error",
    errorType: "forbidden",
  });
  assertEquals(httpControlOutcome(404), {
    status: "user_error",
    errorType: "not_found",
  });
  assertEquals(httpControlOutcome(418), {
    status: "user_error",
    errorType: "http_418",
  });
  assertEquals(httpControlOutcome(503), {
    status: "error",
    errorType: "unavailable",
  });
});

Deno.test("workflowControlActionOf: names the five control requests and nothing else", () => {
  assertEquals(workflowControlActionOf("workflow.approve"), "approve");
  assertEquals(workflowControlActionOf("workflow.reject"), "reject");
  assertEquals(workflowControlActionOf("workflow.resume"), "resume");
  assertEquals(workflowControlActionOf("workflow.signal"), "signal");
  assertEquals(workflowControlActionOf("workflow.cancel"), "cancel");
  assertEquals(workflowControlActionOf("workflow.run"), undefined);
  assertEquals(workflowControlActionOf("cancel"), undefined);
});
