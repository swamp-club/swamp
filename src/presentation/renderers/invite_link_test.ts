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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { consumeStream } from "../../libswamp/mod.ts";
import type { InviteLinkEvent } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { createInviteLinkRenderer } from "./invite_link.ts";

const LINK = { code: "abc123", url: "https://swamp.club/r/abc123" };

async function* toStream(
  events: InviteLinkEvent[],
): AsyncGenerator<InviteLinkEvent> {
  for (const e of events) yield e;
}

/** Capture both streams separately — the split is the thing under test. */
async function capture(
  run: () => Promise<void>,
): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg: string) => out.push(msg);
  console.error = (msg: string) => err.push(msg);
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out, err };
}

Deno.test("createInviteLinkRenderer: log mode puts the bare URL alone on stdout", async () => {
  const { out, err } = await capture(async () => {
    const renderer = createInviteLinkRenderer("log");
    await consumeStream(
      toStream([{ kind: "completed", data: LINK }]),
      renderer.handlers(),
    );
  });

  // Exactly one stdout line, and it is the URL with nothing around it — this
  // is what keeps `swamp invite link | pbcopy` usable.
  assertEquals(out, ["https://swamp.club/r/abc123"]);
  // The prose exists, but on the other stream.
  assertStringIncludes(err.join("\n"), "Marsh Skulker");
});

Deno.test("createInviteLinkRenderer: json mode emits exactly the two documented keys", async () => {
  const { out, err } = await capture(async () => {
    const renderer = createInviteLinkRenderer("json");
    await consumeStream(
      toStream([{ kind: "completed", data: LINK }]),
      renderer.handlers(),
    );
  });

  assertEquals(out.length, 1);
  assertEquals(JSON.parse(out[0]), LINK);
  assertEquals(Object.keys(JSON.parse(out[0])).sort(), ["code", "url"]);
  // Nothing on stderr in json mode — a --json consumer gets a clean pipe.
  assertEquals(err, []);
});

Deno.test("createInviteLinkRenderer: both modes raise an error event as a UserError", async () => {
  for (const mode of ["log", "json"] as const) {
    await assertRejects(
      () =>
        capture(async () => {
          const renderer = createInviteLinkRenderer(mode);
          await consumeStream(
            toStream([
              {
                kind: "error",
                error: { code: "network", message: "swamp-club is down" },
              },
            ]),
            renderer.handlers(),
          );
        }),
      UserError,
      "swamp-club is down",
    );
  }
});

Deno.test("createInviteLinkRenderer: -q suppresses the note but never the link", async () => {
  const { out, err } = await capture(async () => {
    const renderer = createInviteLinkRenderer("log", true);
    await consumeStream(
      toStream([{ kind: "completed", data: LINK }]),
      renderer.handlers(),
    );
  });

  // The link is what the user asked for — `-q` suppresses commentary, not
  // output. This assertion matters as much as the one below it.
  assertEquals(out, ["https://swamp.club/r/abc123"]);
  assertEquals(err, []);
});

Deno.test("createInviteLinkRenderer: the note survives when not quiet", async () => {
  // Both the explicit false and the default, since the default is what the
  // three older tests in this file rely on.
  const factories = [
    () => createInviteLinkRenderer("log", false),
    () => createInviteLinkRenderer("log"),
  ];

  for (const makeRenderer of factories) {
    const { out, err } = await capture(async () => {
      const renderer = makeRenderer();
      await consumeStream(
        toStream([{ kind: "completed", data: LINK }]),
        renderer.handlers(),
      );
    });

    assertEquals(out, ["https://swamp.club/r/abc123"]);
    assertStringIncludes(err.join("\n"), "Marsh Skulker");
  }
});
