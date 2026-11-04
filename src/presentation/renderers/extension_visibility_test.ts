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

import { assertEquals, assertThrows } from "@std/assert";
import { consumeStream } from "../../libswamp/stream.ts";
import type {
  ExtensionVisibilityData,
  ExtensionVisibilityEvent,
} from "../../libswamp/extensions/visibility.ts";
import { UserError } from "../../domain/errors.ts";
import { createExtensionVisibilityRenderer } from "./extension_visibility.ts";
import { captureLog } from "./search_list_test_helpers.ts";

async function* events(
  ...list: ExtensionVisibilityEvent[]
): AsyncIterable<ExtensionVisibilityEvent> {
  for (const e of list) yield e;
}

const changed: ExtensionVisibilityData = {
  name: "@myorg/ext",
  before: "private",
  after: "public",
  changed: true,
  dryRun: false,
};

Deno.test("JsonExtensionVisibilityRenderer: completed prints the data as is", async () => {
  const lines = await captureLog(() =>
    consumeStream(
      events({ kind: "completed", data: changed }),
      createExtensionVisibilityRenderer("json").handlers(),
    )
  );
  assertEquals(JSON.parse(lines.join("\n")), changed);
});

Deno.test("LogExtensionVisibilityRenderer: read, change and dry run render without error", async () => {
  const renderer = createExtensionVisibilityRenderer("log");
  for (
    const data of [
      changed,
      { ...changed, after: "private" as const, changed: false },
      { ...changed, dryRun: true },
      {
        ...changed,
        after: "private" as const,
        changed: false,
        requested: "public" as const,
      },
      { ...changed, before: "public" as const, after: "private" as const },
    ]
  ) {
    await consumeStream(
      events({ kind: "completed", data }),
      renderer.handlers(),
    );
  }
});

Deno.test("createExtensionVisibilityRenderer: an error event throws UserError in both modes", () => {
  for (const mode of ["log", "json"] as const) {
    const handlers = createExtensionVisibilityRenderer(mode).handlers();
    assertThrows(
      () =>
        handlers.error({
          kind: "error",
          error: { code: "forbidden", message: "Forbidden" },
        }),
      UserError,
      "Forbidden",
    );
  }
});
