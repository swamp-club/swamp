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

import { assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import {
  assertSupportedDatastoreFormat,
  InvalidDatastoreFormatMarkerError,
  UnsupportedDatastoreFormatError,
} from "./datastore_format.ts";

const marker = fc.record(
  {
    format: fc.integer({ min: 1, max: 1_000 }),
    minReaderFormat: fc.integer({ min: 1, max: 1_000 }),
    writtenBy: fc.string(),
  },
  { requiredKeys: ["format"] },
);

function read(value: unknown) {
  return {
    kind: "present" as const,
    source: "_control/datastore-format",
    bytes: new TextEncoder().encode(JSON.stringify(value)),
  };
}

Deno.test("assertSupportedDatastoreFormat: passes exactly when the reader format required is at most 2", () => {
  fc.assert(
    fc.property(marker, (m) => {
      const required = m.minReaderFormat ?? m.format;
      if (required <= 2) {
        assertEquals(assertSupportedDatastoreFormat(read(m)), {
          kind: "supported",
          format: m.format,
        });
      } else {
        assertThrows(
          () => assertSupportedDatastoreFormat(read(m)),
          UnsupportedDatastoreFormatError,
        );
      }
    }),
  );
});

Deno.test("assertSupportedDatastoreFormat: arbitrary bytes either parse as a marker or refuse, never pass silently as v2", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
      try {
        const decision = assertSupportedDatastoreFormat({
          kind: "present",
          source: "s",
          bytes,
        });
        // Only a real marker gets here; it names its own format.
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        assertEquals(decision, { kind: "supported", format: parsed.format });
      } catch (error) {
        if (
          !(error instanceof InvalidDatastoreFormatMarkerError) &&
          !(error instanceof UnsupportedDatastoreFormatError)
        ) {
          throw error;
        }
      }
    }),
  );
});
