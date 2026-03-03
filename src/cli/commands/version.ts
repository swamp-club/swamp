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

import { Command } from "@cliffy/command";
import {
  renderVersion,
  type VersionData,
} from "../../presentation/output/output.ts";
import { createContext, type GlobalOptions } from "../context.ts";

// This gets replaced by the compile script during release builds
export const VERSION = "20260206.200442.0-sha.";

export function getVersionData(): VersionData {
  return { version: VERSION };
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const versionCommand = new Command()
  .description("Display the version of swamp")
  .action(function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["version"]);
    ctx.logger.debug("Executing version command");
    ctx.logger
      .debug`Output mode: ${ctx.outputMode}, verbosity: ${ctx.verbosity}`;

    const data = getVersionData();
    renderVersion(data, ctx.outputMode);

    ctx.logger.debug("Version command completed");
  });
