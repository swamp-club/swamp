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
import { createAuditEvent } from "../../domain/serve_audit/audit_event.ts";
import { AUDIT_CSV_HEADER, formatAuditCsvRow } from "./csv_formatter.ts";

function event(client?: string) {
  return createAuditEvent({
    instanceId: "inst-1",
    category: "execution",
    stage: "response",
    outcome: "success",
    action: "workflow.approve",
    resourceKind: "workflow",
    resourceName: "deploy",
    principalKind: "user",
    principalId: "bob",
    initiatedBy: "user:bob",
    sourceIp: "10.0.0.1",
    requestId: "req-1",
    ...(client !== undefined ? { client } : {}),
  });
}

function column(row: string, name: string): string {
  return row.split(",")[AUDIT_CSV_HEADER.split(",").indexOf(name)];
}

Deno.test("AUDIT_CSV_HEADER: client sits with the other identity columns", () => {
  const columns = AUDIT_CSV_HEADER.split(",");
  assertEquals(columns.indexOf("client"), columns.indexOf("initiatedBy") + 1);
});

Deno.test("formatAuditCsvRow: the client is under its header when set", () => {
  assertEquals(
    column(formatAuditCsvRow(event("direct:cli")), "client"),
    "direct:cli",
  );
  assertEquals(
    column(formatAuditCsvRow(event("direct:cli")), "sourceIp"),
    "10.0.0.1",
  );
});

Deno.test("formatAuditCsvRow: a row with no client keeps every column aligned", () => {
  const row = formatAuditCsvRow(event());
  assertEquals(column(row, "client"), "");
  assertEquals(column(row, "sourceIp"), "10.0.0.1");
  assertEquals(row.split(",").length, AUDIT_CSV_HEADER.split(",").length);
});
