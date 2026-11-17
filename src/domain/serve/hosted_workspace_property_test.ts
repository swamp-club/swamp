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
import {
  HOSTED_WORKSPACE_WANTED,
  hostedWantedOf,
  HostedWorkspace,
} from "./hosted_workspace.ts";

type Command = "suspend" | "resume" | "markDeleted";

const arbCommand = fc.constantFrom<Command>("suspend", "resume", "markDeleted");
const arbDate = fc.date({
  min: new Date("2020-01-01T00:00:00.000Z"),
  max: new Date("2040-01-01T00:00:00.000Z"),
  noInvalidDate: true,
});

function apply(
  workspace: HostedWorkspace,
  command: Command,
  at: Date,
): HostedWorkspace | "refused" {
  try {
    return workspace[command](at);
  } catch {
    return "refused";
  }
}

Deno.test("HostedWorkspace: deleted is never left, and a refused command changes nothing", () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(arbCommand, arbDate), { maxLength: 40 }),
      (commands) => {
        let workspace = HostedWorkspace.create(
          "edge-dns",
          "alice",
          new Date(0),
        );
        let deleted = false;
        for (const [command, at] of commands) {
          const next = apply(workspace, command, at);
          if (next === "refused") {
            assert(deleted, "only a deleted workspace refuses a command");
            continue;
          }
          if (deleted) assertEquals(next.wanted, "deleted");
          workspace = next;
          deleted ||= workspace.wanted === "deleted";
          assertEquals(workspace.name, "edge-dns");
          assertEquals(workspace.creator, "alice");
        }
      },
    ),
  );
});

Deno.test("HostedWorkspace: a command to the state it already has keeps the record unchanged", () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(arbCommand, arbDate), { maxLength: 20 }),
      arbDate,
      (commands, at) => {
        let workspace = HostedWorkspace.active("edge-dns");
        for (const [command, when] of commands) {
          const next = apply(workspace, command, when);
          if (next !== "refused") workspace = next;
        }
        const same: Record<string, Command> = {
          active: "resume",
          suspended: "suspend",
          deleted: "markDeleted",
        };
        const again = apply(workspace, same[workspace.wanted], at);
        assert(again !== "refused");
        assert(again.equals(workspace));
      },
    ),
  );
});

Deno.test("HostedWorkspace: every wanted state maps to a serve state and back", () => {
  for (const wanted of HOSTED_WORKSPACE_WANTED) {
    const workspace = HostedWorkspace.fromRecord({
      name: "edge-dns",
      creator: null,
      wanted,
      changedAt: null,
    });
    assertEquals(hostedWantedOf(workspace.toServeWanted()), wanted);
  }
});
