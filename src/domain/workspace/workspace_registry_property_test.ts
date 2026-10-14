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

import fc from "fast-check";
import { WorkspaceRegistry } from "./workspace_registry.ts";

type Command =
  | { kind: "register"; name: string; path: string }
  | { kind: "remove"; name: string }
  | { kind: "trust"; path: string };

// A small pool, so commands collide on names and paths often.
const arbName = fc.constantFrom("a", "b", "c", "d");
const arbPath = fc.constantFrom("/w/a", "/w/b", "/w/c", "/elsewhere");

const arbCommand: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    kind: fc.constant("register" as const),
    name: arbName,
    path: arbPath,
  }),
  fc.record({ kind: fc.constant("remove" as const), name: arbName }),
  fc.record({ kind: fc.constant("trust" as const), path: arbPath }),
);

Deno.test("WorkspaceRegistry: names and paths stay unique, and removed names are gone, across random commands", () => {
  fc.assert(
    fc.property(fc.array(arbCommand, { maxLength: 40 }), (commands) => {
      const registry = WorkspaceRegistry.empty();
      for (const command of commands) {
        try {
          if (command.kind === "register") {
            registry.register({
              name: command.name,
              path: command.path,
              createdAt: "2026-10-14T00:00:00.000Z",
            });
          } else if (command.kind === "remove") {
            registry.remove(command.name);
            if (registry.get(command.name)) return false;
          } else {
            registry.markTrusted(command.path, "2026-10-14T01:00:00.000Z");
          }
        } catch {
          // A refused register changes nothing; the invariants below still
          // have to hold.
        }
        const entries = registry.list();
        if (new Set(entries.map((e) => e.name)).size !== entries.length) {
          return false;
        }
        if (new Set(entries.map((e) => e.path)).size !== entries.length) {
          return false;
        }
        // Trust belongs to a registered entry, so it goes with it.
        for (const path of ["/w/a", "/w/b", "/w/c", "/elsewhere"]) {
          if (
            registry.isTrusted(path) && !entries.some((e) => e.path === path)
          ) {
            return false;
          }
        }
      }
      return true;
    }),
  );
});
