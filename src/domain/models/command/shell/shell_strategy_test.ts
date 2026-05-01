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

import { assertEquals } from "@std/assert";
import { selectShellStrategy } from "./shell_strategy.ts";
import { PosixShellStrategy } from "./posix_shell_strategy.ts";
import { PowerShellStrategy } from "./powershell_strategy.ts";

Deno.test({
  name: "selectShellStrategy: picks PosixShellStrategy on POSIX hosts",
  ignore: Deno.build.os === "windows",
  fn: () => {
    const strategy = selectShellStrategy();
    assertEquals(strategy instanceof PosixShellStrategy, true);
  },
});

Deno.test({
  name: "selectShellStrategy: picks PowerShellStrategy on native Windows",
  ignore: Deno.build.os !== "windows",
  fn: () => {
    const strategy = selectShellStrategy();
    assertEquals(strategy instanceof PowerShellStrategy, true);
  },
});
