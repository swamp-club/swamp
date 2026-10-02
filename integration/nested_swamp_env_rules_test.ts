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

// Pins the method-to-child allow list (NESTED_SWAMP_ENV_VARS) to the owners
// of the names on it, so a name dropped from the list would silently
// re-break nested swamp; and no credential may ever join the list
// (swamp-club#2032, design/enablers/remote-execution.md).

import { assert, assertEquals } from "@std/assert";
import { NESTED_SWAMP_ENV_VARS } from "../src/domain/remote/environment_snapshot.ts";
import { NESTED_GATE_PASS_ENV } from "../src/domain/auth/nested_gate_pass.ts";
import {
  SWAMP_LOCK_ANCESTOR_PIDS,
  SWAMP_LOCK_HOLDER_PID,
  SWAMP_LOCK_HOLDER_TOKENS,
} from "../src/domain/datastore/lock_holder_marker.ts";
import {
  API_KEY_ENV,
  API_KEY_FILE_ENV,
} from "../src/infrastructure/persistence/api_key_source.ts";
import { SIGNIN_TOKEN_ENV } from "../src/infrastructure/persistence/auth_verification_repository.ts";

Deno.test("nested swamp env: the allow list names the nested pass and the lock markers", () => {
  assertEquals(
    [...NESTED_SWAMP_ENV_VARS].sort(),
    [
      NESTED_GATE_PASS_ENV,
      SWAMP_LOCK_HOLDER_PID,
      SWAMP_LOCK_ANCESTOR_PIDS,
      SWAMP_LOCK_HOLDER_TOKENS,
    ].sort(),
  );
});

Deno.test("nested swamp env: no credential is ever on the allow list", () => {
  for (const credential of [API_KEY_ENV, API_KEY_FILE_ENV, SIGNIN_TOKEN_ENV]) {
    assert(
      !NESTED_SWAMP_ENV_VARS.includes(credential),
      `${credential} must stay stripped from method children`,
    );
  }
});
