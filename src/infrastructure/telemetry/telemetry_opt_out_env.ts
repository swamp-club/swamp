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

export const TELEMETRY_OPT_OUT_ENV_VARS = [
  "SWAMP_NO_TELEMETRY",
  "DO_NOT_TRACK",
] as const;

export type TelemetryOptOutEnvVar = typeof TELEMETRY_OPT_OUT_ENV_VARS[number];

export function telemetryOptOutEnvVarsSet(): TelemetryOptOutEnvVar[] {
  return TELEMETRY_OPT_OUT_ENV_VARS.filter(isOptOutEnvSet);
}

export function isTelemetryDisabledByEnv(): boolean {
  return telemetryOptOutEnvVarsSet().length > 0;
}

function isOptOutEnvSet(name: string): boolean {
  const val = Deno.env.get(name);
  if (val === undefined) return false;
  return val !== "0" && val !== "false" && val !== "";
}
