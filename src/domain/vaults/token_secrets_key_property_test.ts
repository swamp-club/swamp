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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  classifyTokenKeyRecord,
  parseTokenSecretsKeyMaterial,
  serializeTokenKeyMarker,
} from "./token_secrets_key.ts";

const arbKey = fc.uint8Array({ minLength: 32, maxLength: 32 }).filter((k) =>
  !k.every((b) => b === k[0])
);

Deno.test("parseTokenSecretsKeyMaterial: every non-uniform 32-byte key round-trips through hex and base64", () => {
  fc.assert(
    fc.property(arbKey, fc.boolean(), (key, upper) => {
      let hex = Array.from(key).map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (upper) hex = hex.toUpperCase();
      const base64 = btoa(String.fromCharCode(...key));
      assertEquals(parseTokenSecretsKeyMaterial(hex), key);
      assertEquals(parseTokenSecretsKeyMaterial(base64), key);
    }),
  );
});

Deno.test("serializeTokenKeyMarker: markers round-trip and are never mistaken for a key", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1 }),
      fc.string({ minLength: 1 }),
      fc.stringMatching(/^[0-9a-f]{64}$/),
      fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
      (vault, key, fingerprint, migratedAt) => {
        const marker = { vault, key, fingerprint, migratedAt };
        const bytes = serializeTokenKeyMarker(marker);
        assert(bytes.length > 32);
        assertEquals(classifyTokenKeyRecord(bytes), { kind: "marker", marker });
      },
    ),
  );
});
