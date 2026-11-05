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

import { assertEquals } from "@std/assert";
import { withMockedEnv } from "../persistence/path_test_helpers.ts";
import {
  isTelemetryDisabledByEnv,
  telemetryOptOutEnvVarsSet,
} from "./telemetry_opt_out_env.ts";

Deno.test("telemetryOptOutEnvVarsSet: empty, 0 and false are not an opt-out", () => {
  for (const value of [undefined, "", "0", "false"]) {
    withMockedEnv({ SWAMP_NO_TELEMETRY: value, DO_NOT_TRACK: value }, () => {
      assertEquals(telemetryOptOutEnvVarsSet(), [], String(value));
      assertEquals(isTelemetryDisabledByEnv(), false);
    });
  }
});

Deno.test("telemetryOptOutEnvVarsSet: names each variable that opts out", () => {
  withMockedEnv({ SWAMP_NO_TELEMETRY: "true", DO_NOT_TRACK: "1" }, () => {
    assertEquals(telemetryOptOutEnvVarsSet(), [
      "SWAMP_NO_TELEMETRY",
      "DO_NOT_TRACK",
    ]);
    assertEquals(isTelemetryDisabledByEnv(), true);
  });
});

Deno.test("telemetryOptOutEnvVarsSet: one variable is enough", () => {
  withMockedEnv({ SWAMP_NO_TELEMETRY: undefined, DO_NOT_TRACK: "yes" }, () => {
    assertEquals(telemetryOptOutEnvVarsSet(), ["DO_NOT_TRACK"]);
  });
});
