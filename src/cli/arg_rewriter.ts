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
 * Rewrites CLI args to support `swamp model @type method run <method> <name>`.
 *
 * Cliffy's command tree can't route `@type` between `model` and `method run`,
 * so this function detects the pattern and moves `@type` after `run` where
 * model method run can parse it as its first positional.
 *
 * Input:  ["model", "@swamp/cve/dirtyfrag", "method", "run", "scanFleet", "scanner"]
 * Output: ["model", "method", "run", "@swamp/cve/dirtyfrag", "scanFleet", "scanner"]
 */
export function rewriteDirectTypeArgs(args: string[]): string[] {
  const modelIdx = args.indexOf("model");
  if (modelIdx === -1) return args;

  // Find "method" after "model"
  const methodIdx = args.indexOf("method", modelIdx + 1);
  if (methodIdx === -1) return args;

  // Find "run" after "method"
  const runIdx = args.indexOf("run", methodIdx + 1);
  if (runIdx === -1) return args;

  // Find @type between "model" and "method"
  let typeIdx = -1;
  for (let i = modelIdx + 1; i < methodIdx; i++) {
    if (args[i].startsWith("@")) {
      typeIdx = i;
      break;
    }
  }
  if (typeIdx === -1) return args;

  // Rewrite: remove @type from its position and insert after "run"
  const typeArg = args[typeIdx];
  const result = [...args];
  result.splice(typeIdx, 1);

  // Adjust indices after removal
  const adjustedRunIdx = runIdx > typeIdx ? runIdx - 1 : runIdx;
  result.splice(adjustedRunIdx + 1, 0, typeArg);

  return result;
}
