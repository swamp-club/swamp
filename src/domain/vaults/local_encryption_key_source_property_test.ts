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
import { isAbsolute, resolve } from "@std/path";
import fc from "fast-check";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import {
  findChangedKeySourceFields,
  findNonDefaultKeySourceFields,
  LOCAL_ENCRYPTION_KEY_SOURCE_FIELDS,
  withRuntimeBaseDir,
  withServerDefaultKeySource,
} from "./local_encryption_key_source.ts";

const arbValue = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.boolean(),
  fc.constant(undefined),
);

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

// the repo dir is always absolute when a vault loads
const arbRepoDir = fc.stringMatching(/^[a-z0-9]{1,8}$/).map((name) =>
  resolve("/", name)
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
      const result = withServerDefaultKeySource(config);
      assertEquals(findNonDefaultKeySourceFields(result, repoDir), []);
      assertEquals(result.note, config.note);
    }),
  );
});

Deno.test("withServerDefaultKeySource: its result never stores a base_dir", () => {
  fc.assert(
    fc.property(arbConfig, (config) => {
      assertEquals(
        Object.hasOwn(withServerDefaultKeySource(config), "base_dir"),
        false,
      );
    }),
  );
});

Deno.test("withRuntimeBaseDir: a local_encryption config always gets a base_dir, absolute when it is a string, and applying it twice changes nothing", () => {
  withMockedEnv({ HOME: resolve("/home/tester") }, () => {
    fc.assert(
      fc.property(arbConfig, arbRepoDir, (config, repoDir) => {
        const result = withRuntimeBaseDir("local_encryption", config, repoDir);
        if (!config.base_dir) {
          assertEquals(result.base_dir, repoDir);
        } else if (typeof config.base_dir === "string") {
          assert(isAbsolute(result.base_dir as string));
        } else {
          assertEquals(result.base_dir, config.base_dir);
        }
        assertEquals(
          withRuntimeBaseDir("local_encryption", result, repoDir),
          result,
        );
      }),
    );
  });
});

Deno.test("withRuntimeBaseDir: text after a variable other than HOME is kept literally", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,8}$/),
      fc.stringMatching(/^[a-z0-9]{1,8}$/),
      (name, rest) => {
        fc.pre(name !== "HOME");
        const repoDir = resolve("/repo");
        const result = withRuntimeBaseDir(
          "local_encryption",
          { base_dir: `$${name}/${rest}` },
          repoDir,
        );
        assertEquals(result.base_dir, resolve(repoDir, `$${name}/${rest}`));
      },
    ),
  );
});
