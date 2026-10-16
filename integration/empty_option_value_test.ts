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

// The empty option value check over the real command tree (swamp-club#3542).
//
// Cliffy reads an empty `--opt=` as no value and takes the next token, so the
// check runs before it parses. Every option of every command is given an
// empty value — `--opt=` and `--opt ""` — ahead of another flag: an option
// that takes a value must be reported, one that takes none must not.

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { Command } from "@cliffy/command";
import type { AnyCommand } from "../src/cli/cli_schema.ts";
import { registerCommands } from "../src/cli/mod.ts";
import { findEmptyOptionValue } from "../src/cli/empty_option_value.ts";

/** The root as runCli configures it, minus invocation state. */
function buildRoot(): AnyCommand {
  const root = new Command()
    .name("swamp")
    .globalOption("--json", "json")
    .globalOption("--log", "log")
    .globalOption("--log-level <level:string>", "level")
    .globalOption("-q, --quiet", "quiet")
    .globalOption("-v, --verbose", "verbose")
    .globalOption("--no-telemetry", "telemetry")
    .globalOption("--show-properties", "properties")
    .globalOption("--no-color", "color");
  registerCommands(root);
  return root;
}

interface CommandCase {
  path: string[];
  command: AnyCommand;
}

function collectCases(
  command: AnyCommand,
  path: string[],
  out: CommandCase[],
): CommandCase[] {
  if (path.length > 0) out.push({ path, command });
  for (const child of command.getCommands(true)) {
    collectCases(child, [...path, child.getName()], out);
  }
  return out;
}

const ROOT = buildRoot();
const CASES = collectCases(ROOT, [], []);

Deno.test("empty option value: the tree has commands to check", () => {
  assert(CASES.length > 100, `only ${CASES.length} commands found`);
});

Deno.test("empty option value: the title Cliffy would swallow a flag into is reported", () => {
  assertEquals(
    findEmptyOptionValue(ROOT, [
      "issue",
      "bug",
      "--title=",
      "--no-redact",
      "--body",
      "desc",
    ]),
    "--title",
  );
  assertEquals(
    findEmptyOptionValue(ROOT, [
      "issue",
      "bug",
      "--title",
      "probe",
      "--body",
      "desc",
      "--no-redact",
    ]),
    undefined,
  );
});

Deno.test("empty option value: every option of every command is checked by what it takes", () => {
  const wrong: string[] = [];
  let valueOptions = 0;
  for (const { path, command } of CASES) {
    for (const option of command.getOptions(true)) {
      if (option.name.startsWith("no-")) continue;
      const flag = option.name.length > 1
        ? `--${option.name}`
        : `-${option.name}`;
      const takesValue = (option.args ?? []).length > 0;
      if (takesValue) valueOptions++;
      const expected = takesValue ? flag : undefined;
      const found = findEmptyOptionValue(ROOT, [...path, `${flag}=`, "--json"]);
      if (found !== expected) {
        wrong.push(`${path.join(" ")} ${flag}= -> ${found}`);
      }
      const spaced = findEmptyOptionValue(ROOT, [...path, flag, "", "--json"]);
      if (spaced !== expected) {
        wrong.push(`${path.join(" ")} ${flag} "" -> ${spaced}`);
      }
    }
  }
  assertEquals(wrong, []);
  assert(valueOptions > 100, `only ${valueOptions} value options checked`);
});
