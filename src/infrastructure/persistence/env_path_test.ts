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
import { collapseEnvVars, expandEnvVars } from "./env_path.ts";

// ============================================================================
// expandEnvVars
// ============================================================================

Deno.test("expandEnvVars - expands ~ to HOME", () => {
  const home = Deno.env.get("HOME");
  if (!home) return; // Skip if HOME not set
  assertEquals(expandEnvVars("~/data/store"), `${home}/data/store`);
});

Deno.test("expandEnvVars - expands ~ alone", () => {
  const home = Deno.env.get("HOME");
  if (!home) return;
  assertEquals(expandEnvVars("~"), home);
});

Deno.test("expandEnvVars - expands $HOME", () => {
  const home = Deno.env.get("HOME");
  if (!home) return;
  assertEquals(expandEnvVars("$HOME/data/store"), `${home}/data/store`);
});

Deno.test("expandEnvVars - expands ${HOME}", () => {
  const home = Deno.env.get("HOME");
  if (!home) return;
  assertEquals(expandEnvVars("${HOME}/data/store"), `${home}/data/store`);
});

Deno.test("expandEnvVars - expands multiple variables", () => {
  const original = Deno.env.get("SWAMP_TEST_VAR_A");
  const originalB = Deno.env.get("SWAMP_TEST_VAR_B");
  try {
    Deno.env.set("SWAMP_TEST_VAR_A", "/alpha");
    Deno.env.set("SWAMP_TEST_VAR_B", "beta");
    assertEquals(
      expandEnvVars("$SWAMP_TEST_VAR_A/${SWAMP_TEST_VAR_B}/path"),
      "/alpha/beta/path",
    );
  } finally {
    if (original) Deno.env.set("SWAMP_TEST_VAR_A", original);
    else Deno.env.delete("SWAMP_TEST_VAR_A");
    if (originalB) Deno.env.set("SWAMP_TEST_VAR_B", originalB);
    else Deno.env.delete("SWAMP_TEST_VAR_B");
  }
});

Deno.test("expandEnvVars - throws on undefined $VAR", () => {
  Deno.env.delete("SWAMP_UNDEFINED_TEST_VAR");
  assertThrows(
    () => expandEnvVars("$SWAMP_UNDEFINED_TEST_VAR/path"),
    Error,
    'Environment variable "SWAMP_UNDEFINED_TEST_VAR" is not set',
  );
});

Deno.test("expandEnvVars - throws on undefined ${VAR}", () => {
  Deno.env.delete("SWAMP_UNDEFINED_TEST_VAR");
  assertThrows(
    () => expandEnvVars("${SWAMP_UNDEFINED_TEST_VAR}/path"),
    Error,
    'Environment variable "SWAMP_UNDEFINED_TEST_VAR" is not set',
  );
});

Deno.test("expandEnvVars - throws on empty $VAR value", () => {
  const original = Deno.env.get("SWAMP_EMPTY_TEST_VAR");
  try {
    Deno.env.set("SWAMP_EMPTY_TEST_VAR", "");
    assertThrows(
      () => expandEnvVars("$SWAMP_EMPTY_TEST_VAR/path"),
      Error,
      'Environment variable "SWAMP_EMPTY_TEST_VAR" is not set or empty',
    );
  } finally {
    if (original) Deno.env.set("SWAMP_EMPTY_TEST_VAR", original);
    else Deno.env.delete("SWAMP_EMPTY_TEST_VAR");
  }
});

Deno.test("expandEnvVars - absolute path passes through unchanged", () => {
  assertEquals(expandEnvVars("/absolute/path"), "/absolute/path");
});

Deno.test("expandEnvVars - relative path passes through unchanged", () => {
  assertEquals(expandEnvVars("relative/path"), "relative/path");
});

Deno.test("expandEnvVars - tilde mid-path is not expanded", () => {
  assertEquals(expandEnvVars("/foo~bar/baz"), "/foo~bar/baz");
});

// ============================================================================
// collapseEnvVars
// ============================================================================

Deno.test("collapseEnvVars - collapses HOME prefix", () => {
  const home = Deno.env.get("HOME");
  if (!home) return;
  assertEquals(collapseEnvVars(`${home}/data/store`), "$HOME/data/store");
});

Deno.test("collapseEnvVars - collapses exact HOME match", () => {
  const home = Deno.env.get("HOME");
  if (!home) return;
  assertEquals(collapseEnvVars(home), "$HOME");
});

Deno.test("collapseEnvVars - non-HOME path passes through", () => {
  assertEquals(collapseEnvVars("/opt/data/store"), "/opt/data/store");
});

Deno.test("collapseEnvVars - roundtrips with expandEnvVars", () => {
  const home = Deno.env.get("HOME");
  if (!home) return;
  const original = `${home}/my-project/data`;
  const collapsed = collapseEnvVars(original);
  assertEquals(collapsed, "$HOME/my-project/data");
  assertEquals(expandEnvVars(collapsed), original);
});
