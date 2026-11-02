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
import { loadIdentity, USER_AGENT } from "./load_identity.ts";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";

Deno.test("USER_AGENT identifies the CLI and carries the version", () => {
  assertStringIncludes(USER_AGENT, "swamp-cli/");
});

Deno.test("loadIdentity returns empty identity when config dir is unresolvable", async () => {
  // HOME can be unset (Windows test envs strip it); loadIdentity runs at
  // startup for every command and must return {} rather than throw
  await withMockedEnv({
    HOME: undefined,
    USERPROFILE: undefined,
    XDG_CONFIG_HOME: undefined,
  }, async () => {
    const identity = await loadIdentity();
    assertEquals(identity.bearerToken, undefined);
    assertEquals(identity.distinctId, undefined);
    // User-Agent is independent of the file system and must always be set,
    // even when device/auth identity resolution fails.
    assertEquals(identity.userAgent, USER_AGENT);
  });
});
