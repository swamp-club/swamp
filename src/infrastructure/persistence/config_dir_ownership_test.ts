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
import { ownsDirectory, processOwnsConfigDir } from "./config_dir_ownership.ts";
import { withMockedEnv } from "./path_test_helpers.ts";

Deno.test("ownsDirectory: a dir owned by this uid is owned", () => {
  assertEquals(ownsDirectory("/cfg", 501, () => 501), true);
});

Deno.test("ownsDirectory: a dir owned by another uid is not owned", () => {
  assertEquals(ownsDirectory("/cfg", 0, () => 501), false);
});

Deno.test("ownsDirectory: a missing dir is owned, since this process creates it", () => {
  assertEquals(
    ownsDirectory("/cfg", 0, () => {
      throw new Deno.errors.NotFound("missing");
    }),
    true,
  );
});

Deno.test("ownsDirectory: platforms without uids always own the dir", () => {
  assertEquals(ownsDirectory("/cfg", null, () => 501), true);
  assertEquals(ownsDirectory("/cfg", 501, () => null), true);
});

Deno.test("processOwnsConfigDir: owns a config dir this process created", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withMockedEnv({ SWAMP_CONFIG_DIR: dir }, () => {
      assertEquals(processOwnsConfigDir(), true);
    });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
