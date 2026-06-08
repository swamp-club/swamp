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
  createCreekCallDeps,
  createLibSwampContext,
  creekCall,
} from "../../libswamp/mod.ts";
import { createCreekCallRenderer } from "../../presentation/renderers/creek_call.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Parses `--arg key=value` flags into a plain object. Values are auto-coerced:
 * `true`/`false` → boolean, integer/decimal strings → numbers, everything
 * else stays a string. Use `--args-json '{...}'` when you need raw control
 * over types.
 */
function parseArgFlags(raw: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of raw ?? []) {
    const eq = item.indexOf("=");
    if (eq < 0) {
      throw new UserError(`--arg must be key=value, got "${item}"`);
    }
    const key = item.slice(0, eq);
    const value = item.slice(eq + 1);
    if (value === "true") out[key] = true;
    else if (value === "false") out[key] = false;
    else if (value === "null") out[key] = null;
    else if (/^-?\d+$/.test(value)) out[key] = Number(value);
    else if (/^-?\d+\.\d+$/.test(value)) out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}

export const creekCallCommand = new Command()
  .name("call")
  .description("Invoke a method on a registered creek directly (for debugging)")
  .arguments("<type:string> <method:string>")
  .option(
    "--arg <keyValue:string>",
    "Argument in key=value form. Repeat for multiple keys.",
    { collect: true },
  )
  .option(
    "--args-json <json:string>",
    "Pass arguments as a single JSON object (alternative to --arg).",
  )
  .example(
    "Call echo with a value",
    "swamp creek call @swamp/echo-creek echo --arg value=hi",
  )
  .example(
    "Pass JSON args",
    'swamp creek call @me/jira issue --args-json \'{"key":"FOO-1"}\'',
  )
  .action(
    async function (options: AnyOptions, type: string, method: string) {
      const ctx = createContext(options as GlobalOptions, ["creek", "call"]);

      let args: Record<string, unknown> = {};
      if (options.argsJson !== undefined) {
        try {
          const parsed = JSON.parse(options.argsJson as string);
          if (typeof parsed !== "object" || parsed === null) {
            throw new UserError("--args-json must decode to a JSON object");
          }
          args = parsed as Record<string, unknown>;
        } catch (err) {
          throw new UserError(
            `Failed to parse --args-json: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } else {
        args = parseArgFlags(options.arg as string[] | undefined);
      }

      const libCtx = createLibSwampContext();
      const deps = await createCreekCallDeps();
      const renderer = createCreekCallRenderer(ctx.outputMode);
      await consumeStream(
        creekCall(libCtx, deps, { type, method, args }, libCtx.signal),
        renderer.handlers(),
      );
    },
  );
