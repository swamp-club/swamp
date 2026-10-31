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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import type { DatastoreStatusData } from "../../libswamp/datastores/status.ts";
import type { OutputMode } from "../output/output.ts";
import { createDatastoreStatusRenderer } from "./datastore_status.ts";

function render(mode: OutputMode, data: DatastoreStatusData): string {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    createDatastoreStatusRenderer(mode).handlers().completed({
      kind: "completed",
      data,
    });
  } finally {
    console.log = origLog;
  }
  return stripAnsiCode(output.join("\n"));
}

const STATUS: DatastoreStatusData = {
  type: "filesystem",
  path: "/tmp/swamp-data",
  healthy: true,
  message: "OK",
  latencyMs: 4,
  directories: ["data"],
};

Deno.test("datastore status renderer: serve's explicit leases are listed with holder and expiry, in both modes (swamp-club#4195)", () => {
  const data: DatastoreStatusData = {
    ...STATUS,
    explicitLeases: [{
      lockKey: "data/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock",
      holder: "user:alice",
      expiresAt: "2026-10-31T12:00:00.000Z",
    }],
  };
  const log = render("log", data);
  assertStringIncludes(log, "Explicit Leases");
  assertStringIncludes(
    log,
    "data/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock - user:alice, until 2026-10-31T12:00:00.000Z",
  );
  assertEquals(JSON.parse(render("json", data)), data);
  assertStringIncludes(
    render("log", { ...STATUS, explicitLeases: [] }),
    "none held",
  );
});

Deno.test("datastore status renderer: a local status lists no lease section", () => {
  assertEquals(render("log", STATUS).includes("Explicit Leases"), false);
});

Deno.test("datastore status renderer: this checkout's kept outbox entries are listed with state and reason, in both modes (swamp-club#4195)", () => {
  const data: DatastoreStatusData = {
    ...STATUS,
    outbox: [
      {
        state: "offline",
        partition: "model--aws%2Fec2--web",
        txnId: "11111111-1111-4111-8111-111111111111",
        savedAt: "2026-10-30T12:00:00.000Z",
      },
      {
        state: "quarantined",
        partition: "model--aws%2Fec2--web",
        txnId: "22222222-2222-4222-8222-222222222222",
        reason: "Not authorized to write model:web (data.save)",
        savedAt: "2026-10-30T12:01:00.000Z",
      },
    ],
  };
  const log = render("log", data);
  assertStringIncludes(log, "Saved In This Checkout");
  assertStringIncludes(log, "offline model--aws%2Fec2--web");
  assertStringIncludes(log, "quarantined model--aws%2Fec2--web");
  assertStringIncludes(log, "Not authorized to write model:web");
  assertEquals(JSON.parse(render("json", data)).outbox, data.outbox);
});

Deno.test("datastore status renderer: serve's quarantined changes are listed held and accepted, in both modes (swamp-club#4195)", () => {
  const data: DatastoreStatusData = {
    ...STATUS,
    quarantine: [
      {
        txnId: "33333333-3333-4333-8333-333333333333",
        partition: "model--aws%2Fec2--web",
        author: "user:bob",
        reason: "Not authorized to write model:web (data.save)",
        depositedAt: "2026-10-30T12:00:00.000Z",
        state: "held",
      },
      {
        txnId: "44444444-4444-4444-8444-444444444444",
        partition: "model--aws%2Fec2--web",
        author: "user:bob",
        reason: "Not authorized",
        depositedAt: "2026-10-30T11:00:00.000Z",
        state: "accepted",
        acceptedBy: "user:admin",
        acceptedAt: "2026-10-30T11:30:00.000Z",
        seq: 4,
      },
    ],
    quarantineTruncated: true,
  };
  const log = render("log", data);
  assertStringIncludes(log, "Quarantined Changes");
  assertStringIncludes(
    log,
    "held 33333333-3333-4333-8333-333333333333 - model--aws%2Fec2--web by user:bob",
  );
  assertStringIncludes(log, "accepted by user:admin at 2026-10-30T11:30:00");
  assertStringIncludes(log, "more accepted or discarded changes are kept");
  assertEquals(JSON.parse(render("json", data)).quarantine, data.quarantine);
  assertStringIncludes(
    render("log", { ...STATUS, quarantine: [] }),
    "none kept",
  );
});

Deno.test("datastore status renderer: a serve-mode checkout shows the leases it holds and why serve's section is missing, in both modes (swamp-club#4195)", () => {
  const data: DatastoreStatusData = {
    ...STATUS,
    heldLeases: [{
      lockKey: "data/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock",
      fence: 3,
      expiresAt: "2026-10-31T12:00:00.000Z",
    }],
    serveSectionAbsent: "serve is unreachable",
  };
  const log = render("log", data);
  assertStringIncludes(log, "Leases This Checkout Holds");
  assertStringIncludes(log, "fence 3, until 2026-10-31T12:00:00.000Z");
  assertStringIncludes(
    log,
    "Serve's leases and quarantine: serve is unreachable",
  );
  const json = JSON.parse(render("json", data));
  assertEquals(json.heldLeases[0].fence, 3);
  assertEquals(json.serveSectionAbsent, "serve is unreachable");
});
