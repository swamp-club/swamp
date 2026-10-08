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
import { assertEquals, assertStringIncludes } from "@std/assert";
import { consumeStream } from "../../libswamp/stream.ts";
import type { DatastoreSetupEvent } from "../../libswamp/datastores/setup.ts";
import { createDatastoreSetupRenderer } from "./datastore_setup.ts";

async function* toStream(
  events: DatastoreSetupEvent[],
): AsyncGenerator<DatastoreSetupEvent> {
  for (const event of events) {
    yield event;
  }
}

const keptWarning: DatastoreSetupEvent = {
  kind: "warning",
  data: {
    code: "remote_config_tier_kept",
    message: "kept these local config files: models/m.yaml",
    keptPaths: ["models/m.yaml"],
    localConfigPath: "/repo/.swamp/config",
  },
};

const completed: DatastoreSetupEvent = {
  kind: "completed",
  data: {
    type: "@swamp/s3-datastore",
    filesCopied: 1,
    filesPulled: 2,
    bytesCopied: 10,
    directoriesMigrated: ["data"],
    errors: [],
  },
};

async function captureConsole(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines;
}

Deno.test("createDatastoreSetupRenderer: log mode prints the remote_config_tier_kept message", async () => {
  const renderer = createDatastoreSetupRenderer("log");
  const lines = await captureConsole(() =>
    consumeStream(toStream([keptWarning, completed]), renderer.handlers())
  );
  assertStringIncludes(
    lines.join("\n"),
    "kept these local config files: models/m.yaml",
  );
});

Deno.test("createDatastoreSetupRenderer: json mode lists remote_config_tier_kept in warnings", async () => {
  const renderer = createDatastoreSetupRenderer("json");
  const lines = await captureConsole(() =>
    consumeStream(toStream([keptWarning, completed]), renderer.handlers())
  );
  assertEquals(lines.length, 1);
  const output = JSON.parse(lines[0]);
  assertEquals(output.warnings, [keptWarning.data]);
});
