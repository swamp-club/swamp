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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { type AdmissionPhase, ServeAdmission } from "./serve_admission.ts";

const ORDER: Record<AdmissionPhase, number> = {
  starting: 0,
  open: 1,
  draining: 2,
};

Deno.test("ServeAdmission: phases never move backwards and draining always refuses", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("open", "beginDraining"), { maxLength: 20 }),
      (ops) => {
        const admission = new ServeAdmission();
        let previous = ORDER[admission.phase];
        let drained = false;
        for (const op of ops) {
          if (op === "open") admission.open();
          else {
            admission.beginDraining();
            drained = true;
          }
          const current = ORDER[admission.phase];
          assert(current >= previous);
          previous = current;
          if (drained) assertEquals(admission.refusal()?.code, "draining");
        }
        assertEquals(
          admission.refusal() === undefined,
          admission.phase === "open",
        );
      },
    ),
  );
});
