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
import fc from "fast-check";
import {
  findChangedKeySourceFields,
  findNonDefaultKeySourceFields,
  LOCAL_ENCRYPTION_KEY_SOURCE_FIELDS,
  withServerDefaultKeySource,
} from "./local_encryption_key_source.ts";

const arbValue = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.boolean(),
  fc.constant(undefined),
);

/** Configs that set any mix of key-source fields and other fields. */
const arbConfig = fc.record(
  {
    base_dir: arbValue,
    key_file: arbValue,
    ssh_key_path: arbValue,
    auto_generate: arbValue,
    note: fc.string({ maxLength: 8 }),
  },
  { requiredKeys: [] },
);

Deno.test("findChangedKeySourceFields: a config never differs from a copy of itself", () => {
  fc.assert(
    fc.property(arbConfig, (config) => {
      assertEquals(findChangedKeySourceFields({ ...config }, config), []);
    }),
  );
});

Deno.test("findChangedKeySourceFields: changing one key-source field reports exactly that field", () => {
  fc.assert(
    fc.property(
      arbConfig,
      fc.constantFrom(...LOCAL_ENCRYPTION_KEY_SOURCE_FIELDS),
      arbValue,
      (config, field, value) => {
        fc.pre(value !== (config as Record<string, unknown>)[field]);
        const edited = { ...config, [field]: value };
        assertEquals(findChangedKeySourceFields(edited, config), [field]);
      },
    ),
  );
});

Deno.test("withServerDefaultKeySource: its result never names a non-default key source", () => {
  fc.assert(
    fc.property(arbConfig, fc.string({ maxLength: 12 }), (config, repoDir) => {
      const result = withServerDefaultKeySource(config, repoDir);
      assertEquals(findNonDefaultKeySourceFields(result, repoDir), []);
      assertEquals(result.note, config.note);
    }),
  );
});
