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

/**
 * The strict sensitive-fields reader and the stored-reference parser
 * (typed-secrets 3.3) read back exactly what the writer stores.
 */

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { vaultReferenceText } from "../secrets/run_sensitive_values.ts";
import {
  parseStoredVaultReference,
  readSensitiveFieldsTag,
  SENSITIVE_FIELDS_TAG,
} from "./data_writer.ts";

/** Text the writer puts inside the quotes of a reference: non-empty, no quote. */
const quotedText = fc.string({ minLength: 1 }).filter((text) =>
  !text.includes("'")
);

/** A path segment the strict reader accepts. */
const segment = fc.string({ minLength: 1 }).filter((text) =>
  !text.includes(".") &&
  !["__proto__", "constructor", "prototype"].includes(text)
);

Deno.test("parseStoredVaultReference: reads back every reference the writer stores", () => {
  fc.assert(
    fc.property(quotedText, quotedText, (vaultName, key) => {
      const reference = { vaultName, key };
      assertEquals(
        parseStoredVaultReference(vaultReferenceText(reference)),
        reference,
      );
      // The writer's own text form, as processSensitiveResourceData writes it.
      assertEquals(
        parseStoredVaultReference(
          `\${{ vault.get('${vaultName}', '${key}') }}`,
        ),
        reference,
      );
    }),
    { numRuns: 300 },
  );
});

Deno.test("parseStoredVaultReference: a reference with any text before or after it is not a reference", () => {
  fc.assert(
    fc.property(
      quotedText,
      quotedText,
      fc.string({ minLength: 1 }),
      (vaultName, key, extra) => {
        const text = vaultReferenceText({ vaultName, key });
        assertEquals(parseStoredVaultReference(extra + text), undefined);
        assertEquals(parseStoredVaultReference(text + extra), undefined);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("readSensitiveFieldsTag: reads back the path list the writer stores, split into segments", () => {
  fc.assert(
    fc.property(
      fc.array(fc.array(segment, { minLength: 1, maxLength: 4 }), {
        maxLength: 6,
      }),
      (paths) => {
        const tag = JSON.stringify(paths.map((path) => path.join(".")));
        assertEquals(readSensitiveFieldsTag({ [SENSITIVE_FIELDS_TAG]: tag }), {
          kind: "paths",
          paths,
        });
      },
    ),
    { numRuns: 300 },
  );
});
