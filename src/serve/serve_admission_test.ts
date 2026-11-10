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
import {
  DRAINING_RETRY_AFTER_SECONDS,
  NOT_READY_RETRY_AFTER_SECONDS,
  ServeAdmission,
} from "./serve_admission.ts";

Deno.test("ServeAdmission: refuses with not_ready until startup completes", () => {
  const admission = new ServeAdmission();
  assertEquals(admission.phase, "starting");
  assertEquals(admission.refusal()?.code, "not_ready");
  assertEquals(
    admission.refusal()?.retryAfterSeconds,
    NOT_READY_RETRY_AFTER_SECONDS,
  );
});

Deno.test("ServeAdmission.open: admits run work", () => {
  const admission = new ServeAdmission();
  admission.open();
  assertEquals(admission.phase, "open");
  assertEquals(admission.refusal(), undefined);
});

Deno.test("ServeAdmission.beginDraining: refuses with draining once shutdown begins", () => {
  const admission = new ServeAdmission();
  admission.open();
  admission.beginDraining();
  const refusal = admission.refusal();
  assertEquals(refusal?.code, "draining");
  assertEquals(refusal?.retryAfterSeconds, DRAINING_RETRY_AFTER_SECONDS);
});

Deno.test("ServeAdmission.open: a node draining before startup finished stays draining", () => {
  const admission = new ServeAdmission();
  admission.beginDraining();
  admission.open();
  assertEquals(admission.phase, "draining");
  assertEquals(admission.refusal()?.code, "draining");
});
