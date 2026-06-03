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
import { collectReporterContext } from "./reporter_context_collector.ts";

const INPUTS = {
  extensionName: "@adam/cfgmgmt",
  extensionVersion: "2026.04.22.1",
  swampVersion: "20260422.123456.0-sha.abc123",
};

Deno.test("collectReporterContext: populates runtime fields from Deno", () => {
  const ctx = collectReporterContext(INPUTS);
  assertEquals(ctx.extensionName, INPUTS.extensionName);
  assertEquals(ctx.extensionVersion, INPUTS.extensionVersion);
  assertEquals(ctx.swampVersion, INPUTS.swampVersion);
  assertEquals(ctx.os, Deno.build.os);
  assertEquals(ctx.arch, Deno.build.arch);
  assertEquals(ctx.denoVersion, Deno.version.deno);
});

Deno.test("collectReporterContext: SHELL env var flows through when set", () => {
  const originalShell = Deno.env.get("SHELL");
  Deno.env.set("SHELL", "/bin/zsh-test");
  try {
    const ctx = collectReporterContext(INPUTS);
    assertEquals(ctx.shell, "/bin/zsh-test");
  } finally {
    if (originalShell === undefined) {
      Deno.env.delete("SHELL");
    } else {
      Deno.env.set("SHELL", originalShell);
    }
  }
});

Deno.test("collectReporterContext: SHELL falls back to 'unknown' when unset", () => {
  const originalShell = Deno.env.get("SHELL");
  Deno.env.delete("SHELL");
  try {
    const ctx = collectReporterContext(INPUTS);
    assertEquals(ctx.shell, "unknown");
  } finally {
    if (originalShell !== undefined) {
      Deno.env.set("SHELL", originalShell);
    }
  }
});

Deno.test("collectReporterContext: only populates the seven declared fields", () => {
  const ctx = collectReporterContext(INPUTS);
  const keys = Object.keys(ctx).sort();
  assertEquals(keys, [
    "arch",
    "denoVersion",
    "extensionName",
    "extensionVersion",
    "os",
    "shell",
    "swampVersion",
  ]);
});
