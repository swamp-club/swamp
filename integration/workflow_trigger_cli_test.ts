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
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  readServeConfigFile,
  writeServeConfigFile,
} from "../src/serve/serve_config.ts";

await initializeLogging({});

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch { /* Windows EBUSY */ }
  }
}

Deno.test("trigger CLI round trip: set → read → remove", async () => {
  await withTempDir(async (dir) => {
    await writeServeConfigFile(dir, {
      triggers: {
        "scan-cves": { schedule: "0 3 * * *", inputs: { channel: "#ops" } },
      },
    });

    const afterSet = await readServeConfigFile(dir);
    assertEquals(afterSet?.triggers?.["scan-cves"]?.schedule, "0 3 * * *");
    assertEquals(afterSet?.triggers?.["scan-cves"]?.inputs?.channel, "#ops");

    delete afterSet!.triggers!["scan-cves"];
    if (Object.keys(afterSet!.triggers!).length === 0) {
      delete afterSet!.triggers;
    }
    await writeServeConfigFile(dir, afterSet!);

    const afterRemove = await readServeConfigFile(dir);
    assertEquals(afterRemove?.triggers, undefined);
  });
});

Deno.test("trigger CLI: replace semantics — set replaces entire entry", async () => {
  await withTempDir(async (dir) => {
    await writeServeConfigFile(dir, {
      triggers: {
        "my-workflow": {
          schedule: "0 3 * * *",
          inputs: { channel: "#security" },
        },
      },
    });

    const config = await readServeConfigFile(dir);
    config!.triggers!["my-workflow"] = { schedule: "0 6 * * *" };
    await writeServeConfigFile(dir, config!);

    const result = await readServeConfigFile(dir);
    assertEquals(result?.triggers?.["my-workflow"]?.schedule, "0 6 * * *");
    assertEquals(result?.triggers?.["my-workflow"]?.inputs, undefined);
  });
});

Deno.test("trigger CLI: preserves other config sections", async () => {
  await withTempDir(async (dir) => {
    await writeServeConfigFile(dir, {
      port: 9090,
      host: "0.0.0.0",
      schedule: true,
    });

    const config = await readServeConfigFile(dir);
    const triggers = config!.triggers ?? {};
    triggers["new-workflow"] = { schedule: "0 8 * * 1-5" };
    config!.triggers = triggers;
    await writeServeConfigFile(dir, config!);

    const result = await readServeConfigFile(dir);
    assertEquals(result?.port, 9090);
    assertEquals(result?.host, "0.0.0.0");
    assertEquals(result?.schedule, true);
    assertEquals(
      result?.triggers?.["new-workflow"]?.schedule,
      "0 8 * * 1-5",
    );
  });
});

Deno.test("trigger CLI: multiple triggers coexist", async () => {
  await withTempDir(async (dir) => {
    await writeServeConfigFile(dir, {
      triggers: {
        "workflow-a": { schedule: "0 1 * * *" },
        "workflow-b": { schedule: "0 2 * * *" },
      },
    });

    const config = await readServeConfigFile(dir);
    delete config!.triggers!["workflow-a"];
    await writeServeConfigFile(dir, config!);

    const result = await readServeConfigFile(dir);
    assertEquals(result?.triggers?.["workflow-a"], undefined);
    assertEquals(result?.triggers?.["workflow-b"]?.schedule, "0 2 * * *");
  });
});

Deno.test("trigger CLI: creates serve.yaml from scratch", async () => {
  await withTempDir(async (dir) => {
    const before = await readServeConfigFile(dir);
    assertEquals(before, null);

    await writeServeConfigFile(dir, {
      triggers: { "my-workflow": { schedule: "0 0 * * *" } },
    });

    const after = await readServeConfigFile(dir);
    assertEquals(after?.triggers?.["my-workflow"]?.schedule, "0 0 * * *");
  });
});
