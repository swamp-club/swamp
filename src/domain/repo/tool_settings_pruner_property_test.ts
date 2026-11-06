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
import fc from "fast-check";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { atomicWriteTextFile } from "../../infrastructure/persistence/atomic_write.ts";
import { ToolSettingsPruner } from "./tool_settings_pruner.ts";

const SWAMP_COMMANDS = [
  "swamp audit record --from-hook",
  "  swamp audit record --from-hook  ",
  "/usr/local/bin/swamp audit record --from-hook",
  "swamp audit record --from-hook --tool claude",
];
const USER_COMMANDS = [
  "./lint.sh",
  "swamp audit record --from-hook && echo done",
  "swamp audit record --from-hook --tool cursor",
  "echo swamp audit record --from-hook",
];

const arbCommand = fc.oneof(
  fc.constantFrom(...SWAMP_COMMANDS),
  fc.constantFrom(...USER_COMMANDS),
  fc.string(),
);
const arbHook = fc.oneof(
  fc.record({ type: fc.constant("command"), command: arbCommand }),
  fc.jsonValue(),
);
const arbEntry = fc.oneof(
  fc.record({
    matcher: fc.option(fc.constantFrom("Bash", "Edit", "*", ""), {
      nil: undefined,
    }),
    hooks: fc.array(arbHook, { maxLength: 4 }),
  }, { requiredKeys: ["hooks"] }),
  fc.jsonValue(),
);
const arbSettings = fc.record({
  hooks: fc.oneof(
    fc.dictionary(
      fc.constantFrom("PostToolUse", "PostToolUseFailure", "PreToolUse"),
      fc.array(arbEntry, { maxLength: 4 }),
    ),
    fc.jsonValue(),
  ),
  permissions: fc.jsonValue(),
  extra: fc.jsonValue(),
}, { requiredKeys: [] });

function isSwamp(command: unknown): boolean {
  return typeof command === "string" &&
    SWAMP_COMMANDS.map((c) => c.trim()).includes(command.trim());
}

function userCommands(settings: unknown): string[] {
  const out: string[] = [];
  const hooks = (settings as { hooks?: unknown } | null)?.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return out;
  }
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const inner = (entry as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const hook of inner) {
        const command = (hook as { command?: unknown } | null)?.command;
        if (typeof command === "string" && !isSwamp(command)) {
          out.push(command);
        }
      }
    }
  }
  return out.sort();
}

Deno.test("ToolSettingsPruner property: never throws, keeps every non-swamp command and key, and a second run finds nothing", async () => {
  await fc.assert(
    fc.asyncProperty(arbSettings, async (settings) => {
      const dir = await Deno.makeTempDir({ prefix: "swamp_prune_prop_" });
      try {
        const path = join(dir, ".claude", "settings.local.json");
        await ensureDir(join(dir, ".claude"));
        await Deno.writeTextFile(path, JSON.stringify(settings));

        const pruner = new ToolSettingsPruner(dir, atomicWriteTextFile);
        await pruner.apply(await pruner.find([]));

        let after: Record<string, unknown> = {};
        try {
          after = JSON.parse(await Deno.readTextFile(path));
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        assertEquals(userCommands(after), userCommands(settings));
        for (const key of Object.keys(settings)) {
          if (key !== "hooks") assert(key in after, `lost key ${key}`);
        }
        assertEquals((await pruner.find([])).actions, []);
      } finally {
        if (Deno.build.os === "windows") {
          await Deno.remove(dir, { recursive: true }).catch(() => {});
        } else {
          await Deno.remove(dir, { recursive: true });
        }
      }
    }),
    { numRuns: 60 },
  );
});
