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

import { Command } from "@cliffy/command";
import type { AnyCommand } from "./cli_schema.ts";

const noop = () => {};

/** A small tree shaped like the real one, covering each rule. */
export function buildEmptyOptionTree(): AnyCommand {
  const bug = new Command()
    .option("-t, --title <title:string>", "title")
    .option("-b, --body <body:string>", "body")
    .option("--since [when:string]", "optional value")
    .option("--cache <dir:string>", "cache dir")
    .option("--no-cache", "disable cache")
    .option("--no-redact", "skip redaction")
    .option("-f, --force", "force")
    .action(noop);

  const get = new Command()
    .arguments("<name:string>")
    .option("--format <format:string>", "format")
    .action(noop);

  const issue = new Command()
    .command("bug", bug)
    .command("get", get);

  return new Command()
    .name("swamp")
    .globalOption("--log-level <level:string>", "level")
    .globalOption("-q, --quiet", "quiet")
    .globalOption("-v, --verbose", "verbose")
    .globalOption("--no-color", "color")
    .command("issue", issue);
}
