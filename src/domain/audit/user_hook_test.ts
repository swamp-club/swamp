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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../errors.ts";
import {
  claudeUserAuditHookInstalled,
  claudeUserConfigDir,
  claudeUserSettingsPath,
  installClaudeUserAuditHook,
  removeClaudeUserAuditHook,
} from "./user_hook.ts";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "swamp_user_hook_test_" });
  try {
    await fn(home);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(home, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(home, { recursive: true });
    }
  }
}

const AUDIT = "swamp audit record --from-hook";

const claudeDir = (home: string) => join(home, ".claude");

function entry(command: string, matcher: string): Record<string, unknown> {
  return { matcher, hooks: [{ type: "command", command }] };
}

const SWAMP_ENTRY = entry(AUDIT, "Bash|PowerShell");
const LEGACY_ENTRY = entry(AUDIT, "Bash");

async function readSettings(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await Deno.readTextFile(claudeUserSettingsPath(claudeDir(home))),
  );
}

async function writeSettings(home: string, content: string): Promise<void> {
  await Deno.mkdir(join(home, ".claude"), { recursive: true });
  await Deno.writeTextFile(claudeUserSettingsPath(claudeDir(home)), content);
}

Deno.test("installClaudeUserAuditHook: creates the settings file and .claude dir", async () => {
  await withHome(async (home) => {
    const result = await installClaudeUserAuditHook(claudeDir(home));
    assertEquals(result, {
      settingsPath: claudeUserSettingsPath(claudeDir(home)),
      changed: true,
    });
    assertEquals(await readSettings(home), {
      hooks: {
        PostToolUse: [SWAMP_ENTRY],
        PostToolUseFailure: [SWAMP_ENTRY],
      },
    });
    assertEquals(await claudeUserAuditHookInstalled(claudeDir(home)), true);
  });
});

Deno.test("installClaudeUserAuditHook: keeps every other setting and hook", async () => {
  await withHome(async (home) => {
    const formatter = entry("prettier --write", "Edit|Write");
    await writeSettings(
      home,
      JSON.stringify({
        model: "opus",
        permissions: { allow: ["Bash(ls:*)"] },
        hooks: { PostToolUse: [formatter], Stop: [formatter] },
      }),
    );
    await installClaudeUserAuditHook(claudeDir(home));
    assertEquals(await readSettings(home), {
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        PostToolUse: [formatter, SWAMP_ENTRY],
        Stop: [formatter],
        PostToolUseFailure: [SWAMP_ENTRY],
      },
    });
  });
});

Deno.test("installClaudeUserAuditHook: a second install changes nothing", async () => {
  await withHome(async (home) => {
    await installClaudeUserAuditHook(claudeDir(home));
    const before = await Deno.readTextFile(
      claudeUserSettingsPath(claudeDir(home)),
    );
    assertEquals(
      (await installClaudeUserAuditHook(claudeDir(home))).changed,
      false,
    );
    assertEquals(
      await Deno.readTextFile(claudeUserSettingsPath(claudeDir(home))),
      before,
    );
  });
});

Deno.test("installClaudeUserAuditHook: widens swamp's Bash-only entry", async () => {
  await withHome(async (home) => {
    await writeSettings(
      home,
      JSON.stringify({
        hooks: {
          PostToolUse: [LEGACY_ENTRY],
          PostToolUseFailure: [LEGACY_ENTRY],
        },
      }),
    );
    assertEquals(
      (await installClaudeUserAuditHook(claudeDir(home))).changed,
      true,
    );
    assertEquals((await readSettings(home)).hooks, {
      PostToolUse: [SWAMP_ENTRY],
      PostToolUseFailure: [SWAMP_ENTRY],
    });
  });
});

Deno.test("installClaudeUserAuditHook: keeps a user's own audit hook instead of adding a second", async () => {
  await withHome(async (home) => {
    const wrapped = entry(`timeout 5 ${AUDIT}`, "Bash");
    const settings = {
      hooks: { PostToolUse: [wrapped], PostToolUseFailure: [wrapped] },
    };
    await writeSettings(home, JSON.stringify(settings));
    assertEquals(
      (await installClaudeUserAuditHook(claudeDir(home))).changed,
      false,
    );
    assertEquals(await readSettings(home), settings);
  });
});

Deno.test("installClaudeUserAuditHook: treats an empty file as no settings", async () => {
  await withHome(async (home) => {
    await writeSettings(home, "  \n");
    assertEquals(
      (await installClaudeUserAuditHook(claudeDir(home))).changed,
      true,
    );
    assertEquals(await claudeUserAuditHookInstalled(claudeDir(home)), true);
  });
});

Deno.test("installClaudeUserAuditHook: refuses a file it cannot parse and leaves it untouched", async () => {
  for (const content of ["{ not json", "[1, 2]", '{"hooks": []}']) {
    await withHome(async (home) => {
      await writeSettings(home, content);
      await assertRejects(
        () => installClaudeUserAuditHook(claudeDir(home)),
        UserError,
        "The file was not changed",
      );
      assertEquals(
        await Deno.readTextFile(claudeUserSettingsPath(claudeDir(home))),
        content,
      );
      assertEquals(await claudeUserAuditHookInstalled(claudeDir(home)), false);
    });
  }
});

Deno.test({
  name: "installClaudeUserAuditHook: writes through a symlinked settings file",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHome(async (home) => {
      const dotfiles = join(home, "dotfiles");
      await Deno.mkdir(dotfiles);
      const target = join(dotfiles, "claude-settings.json");
      await Deno.writeTextFile(target, JSON.stringify({ model: "opus" }));
      await Deno.mkdir(join(home, ".claude"));
      await Deno.symlink(target, claudeUserSettingsPath(claudeDir(home)), {
        type: "file",
      });

      await installClaudeUserAuditHook(claudeDir(home));

      const link = await Deno.lstat(claudeUserSettingsPath(claudeDir(home)));
      assertEquals(link.isSymlink, true);
      const written = JSON.parse(await Deno.readTextFile(target));
      assertEquals(written.model, "opus");
      assertEquals(written.hooks.PostToolUse, [SWAMP_ENTRY]);
    });
  },
});

Deno.test({
  name: "installClaudeUserAuditHook: writes into a symlinked .claude dir",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHome(async (home) => {
      const real = join(home, "dotfiles", "claude");
      await Deno.mkdir(real, { recursive: true });
      await Deno.symlink(real, join(home, ".claude"), { type: "dir" });

      await installClaudeUserAuditHook(claudeDir(home));

      assertEquals((await Deno.lstat(join(home, ".claude"))).isSymlink, true);
      const written = JSON.parse(
        await Deno.readTextFile(join(real, "settings.json")),
      );
      assertEquals(written.hooks.PostToolUseFailure, [SWAMP_ENTRY]);
    });
  },
});

Deno.test({
  name: "installClaudeUserAuditHook: refuses a dangling settings symlink",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHome(async (home) => {
      await Deno.mkdir(join(home, ".claude"));
      await Deno.symlink(
        join(home, "missing.json"),
        claudeUserSettingsPath(claudeDir(home)),
        { type: "file" },
      );
      await assertRejects(
        () => installClaudeUserAuditHook(claudeDir(home)),
        UserError,
        "symlink to a file that does not exist",
      );
      assertEquals(
        (await Deno.lstat(claudeUserSettingsPath(claudeDir(home)))).isSymlink,
        true,
      );
    });
  },
});

Deno.test({
  name:
    "installClaudeUserAuditHook: keeps the file mode exactly, past the umask",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withHome(async (home) => {
      await writeSettings(home, "{}");
      await Deno.chmod(claudeUserSettingsPath(claudeDir(home)), 0o666);
      await installClaudeUserAuditHook(claudeDir(home));
      const mode = (await Deno.stat(claudeUserSettingsPath(claudeDir(home))))
        .mode!;
      assertEquals(mode & 0o777, 0o666);
    });
  },
});

Deno.test("removeClaudeUserAuditHook: removes only swamp's entries and empty events", async () => {
  await withHome(async (home) => {
    const formatter = entry("prettier --write", "Edit|Write");
    await writeSettings(
      home,
      JSON.stringify({
        model: "opus",
        hooks: {
          PostToolUse: [formatter, SWAMP_ENTRY],
          PostToolUseFailure: [LEGACY_ENTRY],
          Stop: [formatter],
        },
      }),
    );
    assertEquals(
      (await removeClaudeUserAuditHook(claudeDir(home))).changed,
      true,
    );
    assertEquals(await readSettings(home), {
      model: "opus",
      hooks: { PostToolUse: [formatter], Stop: [formatter] },
    });
    assertEquals(await claudeUserAuditHookInstalled(claudeDir(home)), false);
  });
});

Deno.test("removeClaudeUserAuditHook: drops the hooks key it empties and keeps a user's variant", async () => {
  await withHome(async (home) => {
    await installClaudeUserAuditHook(claudeDir(home));
    await removeClaudeUserAuditHook(claudeDir(home));
    assertEquals(await readSettings(home), {});

    const wrapped = entry(`timeout 5 ${AUDIT}`, "Bash");
    const settings = { hooks: { PostToolUse: [wrapped] } };
    await writeSettings(home, JSON.stringify(settings));
    assertEquals(
      (await removeClaudeUserAuditHook(claudeDir(home))).changed,
      false,
    );
    assertEquals(await readSettings(home), settings);
  });
});

Deno.test("removeClaudeUserAuditHook: a missing file is no change and is not created", async () => {
  await withHome(async (home) => {
    assertEquals(
      (await removeClaudeUserAuditHook(claudeDir(home))).changed,
      false,
    );
    await assertRejects(
      () => Deno.stat(claudeUserSettingsPath(claudeDir(home))),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("claudeUserAuditHookInstalled: needs the hook on both events", async () => {
  await withHome(async (home) => {
    await writeSettings(
      home,
      JSON.stringify({ hooks: { PostToolUse: [SWAMP_ENTRY] } }),
    );
    assertEquals(await claudeUserAuditHookInstalled(claudeDir(home)), false);
  });
});

Deno.test("claudeUserConfigDir: prefers CLAUDE_CONFIG_DIR over the home dir", () => {
  assertEquals(
    claudeUserConfigDir("/home/u", "/cfg/claude"),
    "/cfg/claude",
  );
  assertEquals(
    claudeUserConfigDir("/home/u", undefined),
    join("/home/u", ".claude"),
  );
  assertEquals(claudeUserConfigDir("/home/u", ""), join("/home/u", ".claude"));
});

Deno.test("installClaudeUserAuditHook: writes into a custom Claude config dir", async () => {
  await withHome(async (home) => {
    const dir = join(home, "cfg");
    await installClaudeUserAuditHook(dir);
    assertEquals(await claudeUserAuditHookInstalled(dir), true);
    await assertRejects(
      () => Deno.stat(join(home, ".claude")),
      Deno.errors.NotFound,
    );
  });
});
