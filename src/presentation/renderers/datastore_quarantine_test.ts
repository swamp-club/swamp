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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import type { DatastoreQuarantineAcceptData } from "../../libswamp/datastores/quarantine_accept.ts";
import type { DatastoreQuarantineDiscardData } from "../../libswamp/datastores/quarantine_discard.ts";
import { UserError } from "../../domain/errors.ts";
import type { OutputMode } from "../output/output.ts";
import {
  createDatastoreQuarantineAcceptRenderer,
  createDatastoreQuarantineDiscardRenderer,
} from "./datastore_quarantine.ts";

const DATA: DatastoreQuarantineAcceptData = {
  txnId: "0f8c57cf-4f22-4233-bf81-ecc6b4492fb8",
  partition: "model--aws%2Fec2--web",
  author: "user:bob",
  acceptedBy: "user:admin",
  acceptedAt: "2026-10-30T13:00:00.000Z",
  seq: 4,
  duplicate: false,
  renumbered: [{ name: "vpc", from: 1, to: 3 }],
};

function render(mode: OutputMode, data: DatastoreQuarantineAcceptData): string {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    createDatastoreQuarantineAcceptRenderer(mode).handlers().completed({
      kind: "completed",
      data,
    });
  } finally {
    console.log = origLog;
  }
  return stripAnsiCode(output.join("\n"));
}

Deno.test("datastore quarantine accept renderer: log mode names the author, the admin and the renumbered versions", () => {
  const log = render("log", DATA);
  assertStringIncludes(log, `Accepted: ${DATA.txnId}`);
  assertStringIncludes(log, "Author:    user:bob (it landed as them)");
  assertStringIncludes(log, "user:admin at 2026-10-30T13:00:00.000Z");
  assertStringIncludes(log, "vpc 1 → 3");
  assertStringIncludes(log, "Result: landed");
  assertStringIncludes(
    render("log", { ...DATA, duplicate: true }),
    "(already accepted)",
  );
});

Deno.test("datastore quarantine accept renderer: json mode prints the data as it is", () => {
  assertEquals(JSON.parse(render("json", DATA)), DATA);
});

Deno.test("datastore quarantine accept renderer: an error is a UserError in both modes", () => {
  for (const mode of ["log", "json"] as const) {
    assertThrows(
      () =>
        createDatastoreQuarantineAcceptRenderer(mode).handlers().error({
          kind: "error",
          error: { code: "validation_failed", message: "Not a txnId: x" },
        }),
      UserError,
      "Not a txnId",
    );
  }
});

const DISCARDED: DatastoreQuarantineDiscardData = {
  txnId: "0f8c57cf-4f22-4233-bf81-ecc6b4492fb8",
  partition: "model--aws%2Fec2--web",
  author: "user:bob",
  discardedBy: "user:admin",
  discardedAt: "2026-10-30T13:00:00.000Z",
  duplicate: false,
};

function renderDiscard(
  mode: OutputMode,
  data: DatastoreQuarantineDiscardData,
): string {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    createDatastoreQuarantineDiscardRenderer(mode).handlers().completed({
      kind: "completed",
      data,
    });
  } finally {
    console.log = origLog;
  }
  return stripAnsiCode(output.join("\n"));
}

Deno.test("datastore quarantine discard renderer: log mode names the author and the admin, and says it never lands", () => {
  const log = renderDiscard("log", DISCARDED);
  assertStringIncludes(log, `Discarded: ${DISCARDED.txnId}`);
  assertStringIncludes(log, "Author:    user:bob");
  assertStringIncludes(log, "user:admin at 2026-10-30T13:00:00.000Z");
  assertStringIncludes(log, "Result: discarded");
  assertStringIncludes(log, "it never lands");
  assertStringIncludes(
    renderDiscard("log", { ...DISCARDED, duplicate: true }),
    "(already discarded)",
  );
});

Deno.test("datastore quarantine discard renderer: json mode prints the data as it is, and an error is a UserError", () => {
  assertEquals(JSON.parse(renderDiscard("json", DISCARDED)), DISCARDED);
  for (const mode of ["log", "json"] as const) {
    assertThrows(
      () =>
        createDatastoreQuarantineDiscardRenderer(mode).handlers().error({
          kind: "error",
          error: { code: "validation_failed", message: "Not a txnId: x" },
        }),
      UserError,
      "Not a txnId",
    );
  }
});
