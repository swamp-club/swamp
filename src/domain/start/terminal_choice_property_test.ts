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

import { assert } from "@std/assert";
import fc from "fast-check";
import { orderTerminals } from "./terminal_choice.ts";

const NAMES = [
  "kitty",
  "foot",
  "ghostty",
  "ptyxis-agent",
  "gnome-terminal-server",
  "bash",
  "zsh",
  "tmux",
  "swamp",
  "Terminal",
];

const processes = fc.array(
  fc.record({
    pid: fc.integer({ min: 2, max: 500 }),
    ppid: fc.integer({ min: 0, max: 500 }),
    name: fc.constantFrom(...NAMES),
  }),
  { maxLength: 40 },
);

Deno.test("orderTerminals: property: every terminal appears once, and TERMINAL always leads", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("linux", "darwin", "freebsd"),
      processes,
      fc.integer({ min: 0, max: 500 }),
      fc.option(fc.constantFrom("kitty", "my-term", "/usr/bin/foot")),
      (os, list, selfPid, terminalVar) => {
        const planned = orderTerminals({
          os,
          scriptPath: "/s",
          processes: list,
          selfPid,
          ...(terminalVar !== null ? { terminalVar } : {}),
        });
        const names = planned.map((p) => p.name);
        assert(new Set(names).size === names.length);
        assert(planned.every((p) => p.args.includes("/s")));
        if (os === "darwin") {
          assert(planned[planned.length - 1].chosen === "default");
        } else {
          assert(planned.length >= 12);
          if (terminalVar !== null) assert(planned[0].chosen === "set");
          const rank = { set: 0, running_here: 1 } as Record<string, number>;
          const lead = planned.map((p) => rank[p.chosen] ?? 2);
          assert(lead.every((r, i) => i === 0 || lead[i - 1] <= r));
        }
      },
    ),
  );
});
