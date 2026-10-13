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
import { StartTask } from "./start_task.ts";
import { StartSession, StartTransitionError } from "./start_session.ts";

type Command =
  | { kind: "save"; text: string }
  | { kind: "choose"; harness: "claude" | "codex" | "cursor" }
  | { kind: "back" }
  | { kind: "launch" };

const arbCommand: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    kind: fc.constant("save" as const),
    text: fc.string({ minLength: 1, maxLength: 20 }).filter((t) =>
      t.trim().length > 0
    ),
  }),
  fc.record({
    kind: fc.constant("choose" as const),
    harness: fc.constantFrom(
      "claude" as const,
      "codex" as const,
      "cursor" as const,
    ),
  }),
  fc.constant({ kind: "back" as const }),
  fc.constant({ kind: "launch" as const }),
);

function apply(session: StartSession, command: Command): void {
  const now = new Date("2026-10-03T10:00:00.000Z");
  switch (command.kind) {
    case "save":
      return session.saveTask(StartTask.create(command.text));
    case "choose":
      return session.chooseHarness(command.harness);
    case "back":
      return session.back();
    case "launch":
      return session.confirmTrustAndRecordLaunch(
        { method: "copy_command", command: "c", opened: false },
        now,
      );
  }
}

Deno.test("StartSession: no command sequence reaches launched without task, harness and trust", () => {
  fc.assert(
    fc.property(fc.array(arbCommand, { maxLength: 30 }), (commands) => {
      const session = StartSession.create(
        crypto.randomUUID(),
        "/w",
        new Date("2026-10-03T09:00:00.000Z"),
      );
      for (const command of commands) {
        const before = session.toData();
        try {
          apply(session, command);
        } catch (error) {
          assert(error instanceof StartTransitionError);
          // A refused command leaves the session unchanged.
          assertEquals(session.toData(), before);
        }
        const data = session.toData();
        if (data.step === "launched") {
          assert(data.task !== undefined);
          assert(data.harness !== undefined);
          assert(data.trustConfirmedAt !== undefined);
          assert(data.launch !== undefined);
        }
        if (data.step === "trust") assert(data.harness !== undefined);
        if (data.step !== "task") assert(data.task !== undefined);
        if (data.step !== "launched") {
          assertEquals(data.trustConfirmedAt, undefined);
        }
      }
    }),
  );
});
