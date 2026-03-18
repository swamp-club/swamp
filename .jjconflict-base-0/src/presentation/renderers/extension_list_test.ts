// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertThrows } from "@std/assert";
import { consumeStream } from "../../libswamp/mod.ts";
import type { ExtensionListEvent } from "../../libswamp/mod.ts";
import { createExtensionListRenderer } from "./extension_list.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: ExtensionListEvent[],
): AsyncGenerator<ExtensionListEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("JsonExtensionListRenderer - completed outputs JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createExtensionListRenderer("json");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            extensions: [
              {
                name: "@ns/ext",
                version: "1.0.0",
                pulledAt: "2026-01-01",
                files: [],
              },
            ],
          },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.extensions.length, 1);
    assertEquals(parsed.extensions[0].name, "@ns/ext");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("ExtensionListRenderer - error throws UserError", () => {
  const renderer = createExtensionListRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "test", message: "boom" },
      }),
    UserError,
    "boom",
  );
});
