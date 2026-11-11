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
import type { Principal } from "../domain/access/principal.ts";
import {
  RESUME_INPUTS_REFUSED_MESSAGE,
  type ResumeCaller,
  resumeInputsRefusal,
} from "./resume_caller_rules.ts";

const RUN = { initiatedBy: "user:alice" };

function caller(id: string, accessAdmin = false): ResumeCaller {
  const principal: Principal = { kind: "user", id };
  return {
    principal,
    accessAdmin,
    vaultScope: {
      source: "session",
      principal,
      idpGroups: [],
      collectives: [],
    },
  };
}

Deno.test("resumeInputsRefusal: a resume with no inputs is never refused", () => {
  assertEquals(resumeInputsRefusal(RUN, caller("bob"), undefined), undefined);
  assertEquals(resumeInputsRefusal(RUN, caller("bob"), {}), undefined);
});

Deno.test("resumeInputsRefusal: the person who started the run may add inputs", () => {
  assertEquals(
    resumeInputsRefusal(RUN, caller("alice"), { note: "x" }),
    undefined,
  );
});

Deno.test("resumeInputsRefusal: an access admin may add inputs to anyone's run", () => {
  assertEquals(
    resumeInputsRefusal(RUN, caller("root", true), { note: "x" }),
    undefined,
  );
});

Deno.test("resumeInputsRefusal: anyone else adding inputs is refused, and the message names no key, value or person", () => {
  const refusal = resumeInputsRefusal(RUN, caller("bob"), {
    secretTarget: "hunter2",
  });
  assertEquals(refusal, RESUME_INPUTS_REFUSED_MESSAGE);
  for (const leaked of ["secretTarget", "hunter2", "alice", "bob"]) {
    assertEquals(refusal?.includes(leaked), false);
  }
});

Deno.test("resumeInputsRefusal: a run that names no initiator takes inputs only from an admin", () => {
  assertEquals(
    resumeInputsRefusal({}, caller("bob"), { note: "x" }),
    RESUME_INPUTS_REFUSED_MESSAGE,
  );
  assertEquals(
    resumeInputsRefusal({}, caller("root", true), { note: "x" }),
    undefined,
  );
});

Deno.test("resumeInputsRefusal: a scheduled run takes inputs only from an admin", () => {
  const scheduled = { initiatedBy: "service:scheduler" };
  assertEquals(
    resumeInputsRefusal(scheduled, caller("bob"), { note: "x" }),
    RESUME_INPUTS_REFUSED_MESSAGE,
  );
});

Deno.test("resumeInputsRefusal: with authorization off there is no caller to refuse", () => {
  assertEquals(
    resumeInputsRefusal(
      RUN,
      { principal: null, accessAdmin: false, vaultScope: null },
      { note: "x" },
    ),
    undefined,
  );
});
