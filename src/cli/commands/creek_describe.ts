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
import {
  consumeStream,
  createCreekDescribeDeps,
  createLibSwampContext,
  creekDescribe,
} from "../../libswamp/mod.ts";
import { createCreekDescribeRenderer } from "../../presentation/renderers/creek_describe.ts";
import { createContext, type GlobalOptions } from "../context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const creekDescribeCommand = new Command()
  .name("describe")
  .description("Show methods and argument schemas for a registered creek")
  .arguments("<type:string>")
  .example(
    "Describe a built-in creek",
    "swamp creek describe @swamp/echo-creek",
  )
  .action(async function (options: AnyOptions, type: string) {
    const ctx = createContext(options as GlobalOptions, ["creek", "describe"]);
    const libCtx = createLibSwampContext();
    const deps = await createCreekDescribeDeps();
    const renderer = createCreekDescribeRenderer(ctx.outputMode);
    await consumeStream(
      creekDescribe(libCtx, deps, type),
      renderer.handlers(),
    );
  });
