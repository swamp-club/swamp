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
import type { DataVersionsEvent } from "../../libswamp/mod.ts";
import { createDataVersionsRenderer } from "./data_versions.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: DataVersionsEvent[],
): AsyncGenerator<DataVersionsEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("LogDataVersionsRenderer - completed outputs JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createDataVersionsRenderer("log");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            dataName: "output",
            modelId: "def-1",
            modelName: "my-model",
            modelType: "aws/ec2",
            versions: [
              {
                version: 1,
                createdAt: "2026-01-01T00:00:00.000Z",
                isLatest: true,
              },
            ],
            total: 1,
          },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.dataName, "output");
    assertEquals(parsed.total, 1);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("DataVersionsRenderer - error throws UserError", () => {
  const renderer = createDataVersionsRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Model not found: x" },
      }),
    UserError,
    "Model not found: x",
  );
});
