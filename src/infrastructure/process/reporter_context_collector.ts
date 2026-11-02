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

import type { ReporterContext } from "../../domain/extensions/reporter_context.ts";

export interface ReporterContextInputs {
  extensionName: string;
  extensionVersion: string;
  swampVersion: string;
}

/**
 * the field list is hardcoded: this is the only module allowed to read runtime
 * values into a ReporterContext, which keeps the trust boundary auditable
 */
export function collectReporterContext(
  inputs: ReporterContextInputs,
): ReporterContext {
  return {
    extensionName: inputs.extensionName,
    extensionVersion: inputs.extensionVersion,
    swampVersion: inputs.swampVersion,
    os: Deno.build.os,
    arch: Deno.build.arch,
    shell: Deno.env.get("SHELL") ?? "unknown",
    denoVersion: Deno.version.deno,
  };
}
