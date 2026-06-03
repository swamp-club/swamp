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

Deno.test("USER_AGENT identifies the CLI and carries the version", () => {
  assertStringIncludes(USER_AGENT, "swamp-cli/");
});

Deno.test("loadIdentity returns empty identity when config dir is unresolvable", async () => {
  // Reproduces the Windows test-env scenario where HOME is not set
  // (Windows uses USERPROFILE; minimal test envs strip both). The CLI
  // calls loadIdentity at startup for every command — if this throws,
  // every command crashes with empty stdout. Must return `{}` safely.
  const homeBefore = Deno.env.get("HOME");
  const userProfileBefore = Deno.env.get("USERPROFILE");
  const xdgBefore = Deno.env.get("XDG_CONFIG_HOME");
  Deno.env.delete("HOME");
  Deno.env.delete("USERPROFILE");
  Deno.env.delete("XDG_CONFIG_HOME");
  try {
    const identity = await loadIdentity();
    assertEquals(identity.bearerToken, undefined);
    assertEquals(identity.distinctId, undefined);
    // User-Agent is independent of the file system and must always be set,
    // even when device/auth identity resolution fails.
    assertEquals(identity.userAgent, USER_AGENT);
  } finally {
    if (homeBefore !== undefined) Deno.env.set("HOME", homeBefore);
    if (userProfileBefore !== undefined) {
      Deno.env.set("USERPROFILE", userProfileBefore);
    }
    if (xdgBefore !== undefined) Deno.env.set("XDG_CONFIG_HOME", xdgBefore);
  }
});
