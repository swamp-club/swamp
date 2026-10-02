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
 * In --json mode, an offline auth gate pass warns without breaking stderr: a
 * failing run's stderr is one JSON error document that carries the warning,
 * and any other run's stderr is the one warning line its exit hook writes
 * (swamp-club#2938). The gate warning renderer, the fatal error renderer and
 * the exit hook are wired here as the CLI wires them.
 */

import { assertEquals } from "@std/assert";
import { UserError } from "../src/domain/errors.ts";
import { renderError } from "../src/presentation/output/error_output.ts";
import {
  renderAuthGateWarning,
  takeAuthGateWarning,
} from "../src/presentation/renderers/auth_gate_warning.ts";

function captureStderr(run: () => void): string {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    run();
  } finally {
    console.error = originalError;
    takeAuthGateWarning();
  }
  return lines.map((line) => `${line}\n`).join("");
}

Deno.test("auth gate JSON stderr: a failing offline run writes one JSON document", () => {
  const stderr = captureStderr(() => {
    const exitHooks: (() => void)[] = [];
    renderAuthGateWarning("json", "Running offline", (hook) => {
      exitHooks.push(hook);
    });
    renderError(new UserError("Download failed: unreachable"), "json");
    for (const hook of exitHooks) hook();
  });

  assertEquals(JSON.parse(stderr), {
    error: "Download failed: unreachable",
    warning: "Running offline",
    authMode: "offline",
  });
});

Deno.test("auth gate JSON stderr: a succeeding offline run writes one warning line", () => {
  const stderr = captureStderr(() => {
    const exitHooks: (() => void)[] = [];
    renderAuthGateWarning("json", "Running offline", (hook) => {
      exitHooks.push(hook);
    });
    for (const hook of exitHooks) hook();
  });

  assertEquals(stderr.split("\n").filter((line) => line !== "").length, 1);
  assertEquals(JSON.parse(stderr), {
    warning: "Running offline",
    authMode: "offline",
  });
});
