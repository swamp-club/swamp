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
  type CodexSessionHeader,
  isAgentSessionId,
  pickCodexSession,
} from "./agent_session.ts";

const WS = "/var/home/u/.swamp/workspaces/w";
const LAUNCH = new Date("2026-11-14T10:00:00Z");

function header(
  id: string,
  at: string,
  overrides: Partial<CodexSessionHeader> = {},
): CodexSessionHeader {
  return {
    id,
    startedAt: new Date(at),
    cwd: WS,
    background: false,
    ...overrides,
  };
}

const A = "01a1d2fd-c180-7601-b367-4298b76a0fb0";
const B = "01a1d2fe-0000-7601-b367-4298b76a0fb1";
const C = "01a1d2ff-0000-7601-b367-4298b76a0fb2";

Deno.test("isAgentSessionId: accepts only a UUID", () => {
  assertEquals(isAgentSessionId(A), true);
  assertEquals(isAgentSessionId(A.toUpperCase()), true);
  for (const bad of ["", "-r", `--${A}`, `${A}\n`, 42, null, undefined]) {
    assertEquals(isAgentSessionId(bad), false, String(bad));
  }
});

Deno.test("pickCodexSession: picks the first session in this folder after the launch", () => {
  assertEquals(
    pickCodexSession(
      [
        header(B, "2026-11-14T10:30:00Z"),
        header(A, "2026-11-14T10:00:02Z"),
        header(C, "2026-11-14T09:59:00Z"),
      ],
      WS,
      LAUNCH,
    ),
    A,
  );
});

Deno.test("pickCodexSession: ignores sessions in other folders, background runs and earlier ones", () => {
  assertEquals(
    pickCodexSession(
      [
        header(A, "2026-11-14T10:00:01Z", { cwd: "/home/u/elsewhere" }),
        header(B, "2026-11-14T10:00:02Z", { background: true }),
        header(C, "2026-11-14T09:00:00Z"),
      ],
      WS,
      LAUNCH,
    ),
    null,
  );
});

Deno.test("pickCodexSession: a newer session elsewhere doesn't displace the launched one", () => {
  assertEquals(
    pickCodexSession(
      [
        header(A, "2026-11-14T10:00:05Z"),
        header(B, "2026-11-14T11:00:00Z", { cwd: "/tmp/other" }),
      ],
      WS,
      LAUNCH,
    ),
    A,
  );
});

Deno.test("pickCodexSession: an id that isn't a UUID is never returned", () => {
  assertEquals(
    pickCodexSession([header("--last", "2026-11-14T10:00:05Z")], WS, LAUNCH),
    null,
  );
});
