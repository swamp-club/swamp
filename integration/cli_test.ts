// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertStringIncludes } from "@std/assert";
import { VERSION } from "../src/cli/commands/version.ts";

// Integration tests run the CLI as a subprocess to test end-to-end behavior

async function runCliCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", "dev", ...args],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  });

  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

Deno.test("CLI with no args shows help", async () => {
  const { stdout } = await runCliCommand([]);
  assertStringIncludes(stdout, "swamp");
  assertStringIncludes(stdout, "Usage:");
});

Deno.test("CLI with --help shows help", async () => {
  const { stdout } = await runCliCommand(["--help"]);
  assertStringIncludes(stdout, "swamp");
  assertStringIncludes(stdout, "Usage:");
  assertStringIncludes(stdout, "--json");
  assertStringIncludes(stdout, "--quiet");
  assertStringIncludes(stdout, "--verbose");
});

Deno.test("CLI with --version shows version", async () => {
  const { stdout } = await runCliCommand(["--version"]);
  assertStringIncludes(stdout, VERSION);
});

Deno.test("CLI version command outputs version string in log mode", async () => {
  const { stdout } = await runCliCommand(["version"]);
  // In non-TTY environment, version command outputs plain text
  assertStringIncludes(stdout, "swamp");
  assertStringIncludes(stdout, VERSION);
});

Deno.test("CLI version command with --json outputs JSON", async () => {
  const { stdout } = await runCliCommand(["--json", "version"]);
  // Should be valid JSON with version field
  const parsed = JSON.parse(stdout);
  assertStringIncludes(parsed.version, VERSION);
});
