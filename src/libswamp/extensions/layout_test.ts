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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  classifyExtensionFile,
  detectLegacyExtensionLayout,
  extractTopLevelRoot,
  requireCurrentExtensionLayout,
  summariseLegacyLayout,
  warnLegacyExtensionLayout,
} from "./layout.ts";
import { UserError } from "../../domain/errors.ts";

Deno.test("classifyExtensionFile: pre-.swamp path is gen-1", () => {
  assertEquals(classifyExtensionFile("extensions/models/foo.ts"), "gen-1");
  assertEquals(classifyExtensionFile("extensions/vaults/bar.ts"), "gen-1");
});

Deno.test("classifyExtensionFile: flat under .swamp is gen-2", () => {
  assertEquals(
    classifyExtensionFile(".swamp/pulled-extensions/models/foo.ts"),
    "gen-2",
  );
  assertEquals(
    classifyExtensionFile(".swamp/pulled-extensions/workflows/foo.yaml"),
    "gen-2",
  );
  assertEquals(
    classifyExtensionFile(".swamp/pulled-extensions/vaults/sub/bar.ts"),
    "gen-2",
  );
});

Deno.test("classifyExtensionFile: per-extension subtree is current", () => {
  assertEquals(
    classifyExtensionFile(
      ".swamp/pulled-extensions/@stack72/ubiquity/models/unifi_traffic.ts",
    ),
    "current",
  );
  assertEquals(
    classifyExtensionFile(
      ".swamp/pulled-extensions/@swamp/aws/ec2/models/_lib/aws.ts",
    ),
    "current",
  );
  assertEquals(
    classifyExtensionFile(
      ".swamp/pulled-extensions/@swamp/aws/ec2/manifest.yaml",
    ),
    "current",
  );
});

Deno.test("classifyExtensionFile: .swamp paths outside pulled-extensions are current", () => {
  assertEquals(
    classifyExtensionFile(".swamp/bundles/abc123/foo.js"),
    "current",
  );
  assertEquals(
    classifyExtensionFile(".swamp/bundles/abc123/@scope/name/foo.js"),
    "current",
  );
});

Deno.test("detectLegacyExtensionLayout: returns empty for current layout", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@scope/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [
            ".swamp/pulled-extensions/@scope/ext/models/foo.ts",
            ".swamp/pulled-extensions/@scope/ext/manifest.yaml",
            ".swamp/bundles/abc123/foo.js",
          ],
        },
      }),
    );

    const legacy = await detectLegacyExtensionLayout(lockfilePath);
    assertEquals(legacy, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("detectLegacyExtensionLayout: detects gen-1 paths", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@scope/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [
            "extensions/models/ext.ts",
            ".swamp/bundles/abc123/ext.js",
          ],
        },
      }),
    );

    const legacy = await detectLegacyExtensionLayout(lockfilePath);
    assertEquals(legacy.length, 1);
    assertEquals(legacy[0].extensionName, "@scope/ext");
    assertEquals(legacy[0].file, "extensions/models/ext.ts");
    assertEquals(legacy[0].generation, "gen-1");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("detectLegacyExtensionLayout: detects gen-2 flat-under-.swamp paths", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@swamp/aws/ec2": {
          version: "2026.04.03.2",
          pulledAt: "2026-04-03T00:00:00Z",
          files: [
            ".swamp/pulled-extensions/models/_lib/aws.ts",
            ".swamp/pulled-extensions/models/README.md",
          ],
        },
      }),
    );

    const legacy = await detectLegacyExtensionLayout(lockfilePath);
    assertEquals(legacy.length, 2);
    for (const entry of legacy) {
      assertEquals(entry.extensionName, "@swamp/aws/ec2");
      assertEquals(entry.generation, "gen-2");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("detectLegacyExtensionLayout: mixed generations in one lockfile", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@old/gen1": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: ["extensions/models/old.ts"],
        },
        "@flat/gen2": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/models/flat.ts"],
        },
        "@per/current": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/@per/current/models/ok.ts"],
        },
      }),
    );

    const legacy = await detectLegacyExtensionLayout(lockfilePath);
    assertEquals(legacy.length, 2);
    const byGen = new Map(legacy.map((e) => [e.generation, e]));
    assertEquals(byGen.get("gen-1")?.extensionName, "@old/gen1");
    assertEquals(byGen.get("gen-2")?.extensionName, "@flat/gen2");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("detectLegacyExtensionLayout: returns empty when lockfile missing", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const legacy = await detectLegacyExtensionLayout(lockfilePath);
    assertEquals(legacy, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("summariseLegacyLayout: deduplicates extension names and collects generations", () => {
  const summary = summariseLegacyLayout([
    {
      extensionName: "@a/b",
      file: "extensions/models/foo.ts",
      generation: "gen-1",
    },
    {
      extensionName: "@a/b",
      file: "extensions/models/bar.ts",
      generation: "gen-1",
    },
    {
      extensionName: "@c/d",
      file: ".swamp/pulled-extensions/models/foo.ts",
      generation: "gen-2",
    },
  ]);
  assertEquals(summary.extensionNames, ["@a/b", "@c/d"]);
  assertEquals(summary.fileCount, 3);
  assertEquals(summary.generations.has("gen-1"), true);
  assertEquals(summary.generations.has("gen-2"), true);
});

Deno.test("warnLegacyExtensionLayout: warns on legacy, returns summary", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@scope/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/models/foo.ts"],
        },
      }),
    );

    const messages: string[] = [];
    const summary = await warnLegacyExtensionLayout(
      lockfilePath,
      (msg) => messages.push(msg),
    );
    assertEquals(summary?.extensionNames, ["@scope/ext"]);
    assertEquals(messages.length, 1);
    assertEquals(
      messages[0],
      "1 extension(s) pending migration. Run 'swamp repo upgrade' to complete.",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("warnLegacyExtensionLayout: silent when layout is current", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@scope/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/@scope/ext/models/foo.ts"],
        },
      }),
    );

    const messages: string[] = [];
    const summary = await warnLegacyExtensionLayout(
      lockfilePath,
      (msg) => messages.push(msg),
    );
    assertEquals(summary, undefined);
    assertEquals(messages, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("requireCurrentExtensionLayout: throws on legacy (backwards compat)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@scope/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: ["extensions/models/ext.ts"],
        },
      }),
    );

    await assertRejects(
      () => requireCurrentExtensionLayout(lockfilePath),
      UserError,
      "pending migration",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("requireCurrentExtensionLayout: passes on current layout", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@scope/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/@scope/ext/models/foo.ts"],
        },
      }),
    );
    await requireCurrentExtensionLayout(lockfilePath);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

const SKILLS_DIR = ".claude/skills";

Deno.test("extractTopLevelRoot: per-extension scoped subtree", () => {
  assertEquals(
    extractTopLevelRoot(
      ".swamp/pulled-extensions/@hivemq/harvester/models/foo.ts",
      SKILLS_DIR,
    ),
    ".swamp/pulled-extensions/@hivemq/harvester",
  );
});

Deno.test("extractTopLevelRoot: per-extension flat (unscoped) subtree", () => {
  assertEquals(
    extractTopLevelRoot(
      ".swamp/pulled-extensions/myext/models/foo.ts",
      SKILLS_DIR,
    ),
    ".swamp/pulled-extensions/myext",
  );
});

Deno.test("extractTopLevelRoot: bundle namespace", () => {
  assertEquals(
    extractTopLevelRoot(
      ".swamp/bundles/abc123/foo.js",
      SKILLS_DIR,
    ),
    ".swamp/bundles/abc123",
  );
});

Deno.test("extractTopLevelRoot: each bundle kind", () => {
  for (
    const kind of [
      "bundles",
      "vault-bundles",
      "driver-bundles",
      "datastore-bundles",
      "report-bundles",
    ]
  ) {
    assertEquals(
      extractTopLevelRoot(
        `.swamp/${kind}/hash123/foo.js`,
        SKILLS_DIR,
      ),
      `.swamp/${kind}/hash123`,
    );
  }
});

Deno.test("extractTopLevelRoot: skill dir returns null", () => {
  assertEquals(
    extractTopLevelRoot(".claude/skills/foo", SKILLS_DIR),
    null,
  );
  assertEquals(
    extractTopLevelRoot(".claude/skills/foo/SKILL.md", SKILLS_DIR),
    null,
  );
});

Deno.test("extractTopLevelRoot: gen-1 path returns null", () => {
  assertEquals(
    extractTopLevelRoot("extensions/models/legacy.ts", SKILLS_DIR),
    null,
  );
});

Deno.test("extractTopLevelRoot: gen-2 path returns null", () => {
  assertEquals(
    extractTopLevelRoot(
      ".swamp/pulled-extensions/models/flat.ts",
      SKILLS_DIR,
    ),
    null,
  );
});

Deno.test("extractTopLevelRoot: unknown current-layout path returns null", () => {
  assertEquals(
    extractTopLevelRoot(".swamp/some-other-place/foo.ts", SKILLS_DIR),
    null,
  );
});

Deno.test("extractTopLevelRoot: handles trailing-slash skillsDir", () => {
  assertEquals(
    extractTopLevelRoot(".claude/skills/foo/SKILL.md", ".claude/skills/"),
    null,
  );
});
