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
import { stripAnsiCode } from "@std/fmt/colors";
import type { HubLinkView } from "../../domain/serve/hub_link.ts";
import { renderHubForget, renderHubLink } from "./serve_hub_output.ts";
import {
  assertNoControlCharacters,
  captureRaw,
} from "./terminal_output_test_helpers.ts";

function capture(fn: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(lines.join("\n"));
}

const VIEW: HubLinkView = {
  state: "mismatched",
  hubUrl: "https://hub.example.com",
  configuredHubUrl: "https://other.example.com",
  hubName: "central",
  memberName: "edge",
  memberId: "6f1c2a4e-1111-4222-8333-944445555666",
  joinedAt: "2026-11-26T12:00:00.000Z",
  instances: [{
    instanceId: "0f1c2a4e-1111-4222-8333-944445555666",
    startedAt: "2026-11-26T12:00:00.000Z",
    aliveAt: "2026-11-26T12:00:30.000Z",
    lastAttemptAt: "2026-11-26T12:00:30.000Z",
    lastSuccessAt: null,
    result: "unreachable",
    consecutiveFailures: 3,
    nextAttemptAt: "2026-11-26T12:02:30.000Z",
    stoppedAt: null,
  }],
};

Deno.test("renderHubLink: JSON mode prints the link exactly", () => {
  assertEquals(
    JSON.parse(capture(() => renderHubLink({ link: VIEW }, "json"))),
    { link: VIEW },
  );
});

Deno.test("renderHubLink: log mode names the hub, the hub serve.yaml names, the state, and why an instance is backing off", () => {
  const out = capture(() => renderHubLink({ link: VIEW }, "log"));
  assert(out.includes("https://hub.example.com (central)"));
  assert(out.includes("serve.yaml names: https://other.example.com"));
  assert(out.includes("State: mismatched"));
  assert(
    out.includes(
      "unreachable (3 failures), last attempt 2026-11-26T12:00:30.000Z, next attempt 2026-11-26T12:02:30.000Z",
    ),
  );
  assert(out.includes("swamp serve hub forget --yes"));
});

Deno.test("renderHubForget: says when there was nothing to forget", () => {
  assert(
    capture(() =>
      renderHubForget({ forgot: false, hubUrl: null, memberName: null }, "log")
    ).includes("no hub link"),
  );
});

Deno.test("renderHubLink: a joining link shows its last attempt and next retry, and an attempt with no reply yet", () => {
  const instance = VIEW.instances[0];
  const joining: HubLinkView = {
    ...VIEW,
    state: "joining",
    hubUrl: VIEW.configuredHubUrl,
    memberName: null,
    memberId: null,
    joinedAt: null,
    instances: [
      { ...instance, result: "server_error", consecutiveFailures: 1 },
      {
        ...instance,
        instanceId: "1f1c2a4e-1111-4222-8333-944445555666",
        result: null,
        consecutiveFailures: 0,
        nextAttemptAt: null,
      },
    ],
  };
  const out = capture(() => renderHubLink({ link: joining }, "log"));
  assert(out.includes(
    "server_error (1 failure), last attempt 2026-11-26T12:00:30.000Z, next attempt 2026-11-26T12:02:30.000Z",
  ));
  assert(out.includes("no reply yet, last attempt 2026-11-26T12:00:30.000Z"));
  assert(!out.includes("no check-in yet"));
});

Deno.test("renderHubLink and renderHubForget: control characters the hub sent print escaped, and JSON is unchanged", () => {
  const hostile: HubLinkView = {
    ...VIEW,
    hubName: "central\x1b]0;pwned\x07",
    memberName: "edge\x1b[2K",
  };
  const link = captureRaw(() => renderHubLink({ link: hostile }, "log"));
  assertNoControlCharacters(link);
  assert(stripAnsiCode(link).includes("central\\x1b]0;pwned\\x07"));
  assert(stripAnsiCode(link).includes("edge\\x1b[2K"));
  assertEquals(
    captureRaw(() => renderHubLink({ link: hostile }, "json")),
    JSON.stringify({ link: hostile }, null, 2),
  );
  const forget = captureRaw(() =>
    renderHubForget(
      { forgot: true, hubUrl: "https://hub\x07", memberName: "edge\x1b[2K" },
      "log",
    )
  );
  assertNoControlCharacters(forget);
  assert(stripAnsiCode(forget).includes("https://hub\\x07 as edge\\x1b[2K"));
});
