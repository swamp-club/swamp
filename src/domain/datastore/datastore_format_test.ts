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
import {
  assertSupportedDatastoreFormat,
  DATASTORE_FORMAT_MARKER_INVALID_CODE,
  DATASTORE_FORMAT_MARKER_MAX_BYTES,
  DATASTORE_FORMAT_UNSUPPORTED_CODE,
  type DatastoreFormatMarkerRead,
  InvalidDatastoreFormatMarkerError,
  parseDatastoreFormatMarker,
  UnsupportedDatastoreFormatError,
} from "./datastore_format.ts";
import { UserError } from "../errors.ts";

const SOURCE = "_control/datastore-format";

function present(value: unknown): DatastoreFormatMarkerRead {
  return {
    kind: "present",
    source: SOURCE,
    bytes: new TextEncoder().encode(
      typeof value === "string" ? value : JSON.stringify(value),
    ),
  };
}

Deno.test("assertSupportedDatastoreFormat: a missing marker is format 2 and passes", () => {
  assertEquals(assertSupportedDatastoreFormat({ kind: "absent" }), {
    kind: "supported",
    format: 2,
  });
});

Deno.test("assertSupportedDatastoreFormat: a format 2 marker passes", () => {
  assertEquals(
    assertSupportedDatastoreFormat(
      present({ format: 2, minReaderFormat: 2, writtenBy: "2026.10.08.1" }),
    ),
    { kind: "supported", format: 2 },
  );
});

Deno.test("assertSupportedDatastoreFormat: format 3 refuses with the stable code and message", () => {
  const error = assertThrows(
    () =>
      assertSupportedDatastoreFormat(
        present({ format: 3, minReaderFormat: 3, writtenBy: "2027.01.01.1" }),
      ),
    UnsupportedDatastoreFormatError,
  );
  assertEquals(error.code, DATASTORE_FORMAT_UNSUPPORTED_CODE);
  assertEquals(
    error.message,
    "This datastore uses format 3 (written by swamp 2027.01.01.1). " +
      "This version of swamp supports format 2 only. Upgrade swamp to use " +
      "it. Nothing was changed.",
  );
  assertEquals(error.format, 3);
  assertEquals(error.minReaderFormat, 3);
  assertEquals(error.writtenBy, "2027.01.01.1");
  assertEquals(error instanceof UserError, true);
});

Deno.test("assertSupportedDatastoreFormat: format 3 without minReaderFormat refuses", () => {
  assertThrows(
    () => assertSupportedDatastoreFormat(present({ format: 3 })),
    UnsupportedDatastoreFormatError,
    "This datastore uses format 3. This version",
  );
});

Deno.test("assertSupportedDatastoreFormat: minReaderFormat 3 refuses even when format is 2", () => {
  const error = assertThrows(
    () =>
      assertSupportedDatastoreFormat(
        present({ format: 2, minReaderFormat: 3 }),
      ),
    UnsupportedDatastoreFormatError,
  );
  assertStringIncludes(error.message, "Reading it needs format 3 support.");
});

Deno.test("assertSupportedDatastoreFormat: a newer format readable by format 2 readers passes", () => {
  assertEquals(
    assertSupportedDatastoreFormat(present({ format: 3, minReaderFormat: 2 })),
    { kind: "supported", format: 3 },
  );
});

Deno.test("assertSupportedDatastoreFormat: garbled markers refuse naming the source", () => {
  for (
    const garbled of [
      "not json",
      "[3]",
      "null",
      "3",
      { minReaderFormat: 3 },
      { format: "3" },
      { format: 0 },
      { format: 2.5 },
      { format: 3, minReaderFormat: -1 },
      { format: 2, writtenBy: 7 },
    ]
  ) {
    const error = assertThrows(
      () => assertSupportedDatastoreFormat(present(garbled)),
      InvalidDatastoreFormatMarkerError,
    );
    assertEquals(error.code, DATASTORE_FORMAT_MARKER_INVALID_CODE);
    assertStringIncludes(error.message, SOURCE);
    assertStringIncludes(error.message, "Nothing was changed.");
  }
});

Deno.test("assertSupportedDatastoreFormat: invalid UTF-8 and oversize markers refuse", () => {
  assertThrows(
    () =>
      assertSupportedDatastoreFormat({
        kind: "present",
        source: SOURCE,
        bytes: new Uint8Array([0xff, 0xfe]),
      }),
    InvalidDatastoreFormatMarkerError,
  );
  assertThrows(
    () =>
      assertSupportedDatastoreFormat({
        kind: "present",
        source: SOURCE,
        bytes: new Uint8Array(DATASTORE_FORMAT_MARKER_MAX_BYTES + 1),
      }),
    InvalidDatastoreFormatMarkerError,
    "larger than",
  );
});

Deno.test("assertSupportedDatastoreFormat: a reader-detected invalid marker refuses", () => {
  assertThrows(
    () =>
      assertSupportedDatastoreFormat({
        kind: "invalid",
        source: "/ds/datastore-format.json",
        reason: "not a regular file",
      }),
    InvalidDatastoreFormatMarkerError,
    "/ds/datastore-format.json is not a valid format marker (not a regular file)",
  );
});

Deno.test("assertSupportedDatastoreFormat: a read error proceeds", () => {
  const decision = assertSupportedDatastoreFormat({
    kind: "unreadable",
    source: SOURCE,
    error: new Error("connection reset"),
  });
  assertEquals(decision.kind, "skipped");
  assertStringIncludes(
    (decision as { reason: string }).reason,
    "connection reset",
  );
});

Deno.test("assertSupportedDatastoreFormat: a datastore without a control plane proceeds", () => {
  assertEquals(
    assertSupportedDatastoreFormat({
      kind: "unsupported",
      reason: "@acme/store does not advertise controlPlane",
    }),
    { kind: "skipped", reason: "@acme/store does not advertise controlPlane" },
  );
});

Deno.test("parseDatastoreFormatMarker: tolerates unknown keys", () => {
  assertEquals(
    parseDatastoreFormatMarker(
      new TextEncoder().encode(
        JSON.stringify({ format: 3, minReaderFormat: 3, extra: { a: 1 } }),
      ),
      SOURCE,
    ),
    { format: 3, minReaderFormat: 3 },
  );
});

Deno.test("UnsupportedDatastoreFormatError: strips control characters from writtenBy and caps its length", () => {
  const error = new UnsupportedDatastoreFormatError(
    { format: 3, writtenBy: "\u001b[31m1.0\u0007" + "x".repeat(100) },
    [2],
  );
  assertEquals(error.message.includes("\u001b"), false);
  assertEquals(error.message.includes("\u0007"), false);
  assertStringIncludes(error.message, "(written by swamp [31m1.0xxx");
  assertStringIncludes(error.message, "…)");
});

Deno.test("UnsupportedDatastoreFormatError: omits writtenBy when it is blank", () => {
  assertStringIncludes(
    new UnsupportedDatastoreFormatError({ format: 3, writtenBy: " \n" }, [2])
      .message,
    "This datastore uses format 3. ",
  );
});
