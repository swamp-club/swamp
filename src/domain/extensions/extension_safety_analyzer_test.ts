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
import { join } from "@std/path";
import {
  analyzeExtensionSafety,
  type ContentRule,
} from "./extension_safety_analyzer.ts";

async function withTempFiles(
  files: Record<string, string>,
  fn: (dir: string, paths: string[]) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir();
  try {
    const paths: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const filePath = join(tmpDir, name);
      await Deno.writeTextFile(filePath, content);
      paths.push(filePath);
    }
    await fn(tmpDir, paths);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("analyzeExtensionSafety passes for clean .ts files", async () => {
  await withTempFiles(
    { "model.ts": "export const x = 1;\n" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors, []);
      assertEquals(result.warnings, []);
    },
  );
});

Deno.test("analyzeExtensionSafety errors on disallowed extension", async () => {
  await withTempFiles(
    { "script.sh": "#!/bin/bash\n" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors.length, 1);
      assertEquals(result.errors[0].message.includes(".sh"), true);
    },
  );
});

Deno.test("analyzeExtensionSafety errors on hidden files", async () => {
  await withTempFiles(
    { ".hidden.ts": "export const x = 1;\n" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors.length, 1);
      assertEquals(
        result.errors[0].message.includes("Hidden files"),
        true,
      );
    },
  );
});

Deno.test("analyzeExtensionSafety errors on eval()", async () => {
  await withTempFiles(
    { "evil.ts": 'eval("alert(1)");\n' },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors.length, 1);
      assertEquals(
        result.errors[0].message.includes("eval()"),
        true,
      );
    },
  );
});

Deno.test("analyzeExtensionSafety errors on new Function()", async () => {
  await withTempFiles(
    { "evil.ts": 'const fn = new Function("return 1");\n' },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors.length, 1);
      assertEquals(
        result.errors[0].message.includes("new Function()"),
        true,
      );
    },
  );
});

Deno.test("analyzeExtensionSafety warns on Deno.Command()", async () => {
  await withTempFiles(
    { "cmd.ts": 'const c = new Deno.Command("ls");\n' },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors, []);
      assertEquals(result.warnings.length, 1);
      assertEquals(
        result.warnings[0].message.includes("Deno.Command()"),
        true,
      );
    },
  );
});

Deno.test("analyzeExtensionSafety warns on base64 strings", async () => {
  const longBase64 = "A".repeat(120);
  await withTempFiles(
    { "data.ts": `export const encoded = "${longBase64}";\n` },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors, []);
      assertEquals(result.warnings.length >= 1, true);
      assertEquals(
        result.warnings.some((w) => w.message.includes("base64")),
        true,
      );
    },
  );
});

Deno.test("analyzeExtensionSafety errors on symlinks", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const realFile = join(tmpDir, "real.ts");
    await Deno.writeTextFile(realFile, "export const x = 1;\n");
    const linkFile = join(tmpDir, "link.ts");
    await Deno.symlink(realFile, linkFile, { type: "file" });

    const result = await analyzeExtensionSafety([linkFile]);
    assertEquals(result.errors.length, 1);
    assertEquals(
      result.errors[0].message.includes("Symlinks"),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("analyzeExtensionSafety errors on file count > 150", async () => {
  // Generate 151 fake paths — we don't need real files for count check
  const tmpDir = await Deno.makeTempDir();
  try {
    const paths: string[] = [];
    for (let i = 0; i < 151; i++) {
      const p = join(tmpDir, `file${i}.ts`);
      await Deno.writeTextFile(p, `export const x${i} = ${i};\n`);
      paths.push(p);
    }

    const result = await analyzeExtensionSafety(paths);
    assertEquals(
      result.errors.some((e) => e.message.includes("150")),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("analyzeExtensionSafety allows .json, .md, .yaml, .yml, .txt", async () => {
  await withTempFiles(
    {
      "config.json": '{"key": "value"}',
      "README.md": "# Hello",
      "flow.yaml": "name: test",
      "flow2.yml": "name: test2",
      "notes.txt": "Some notes",
    },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors, []);
      assertEquals(result.warnings, []);
    },
  );
});

Deno.test("analyzeExtensionSafety: exempt files bypass extension check", async () => {
  await withTempFiles(
    { "script.sh": "#!/bin/bash\necho hello\n" },
    async (_dir, paths) => {
      const exempt = new Set(paths);
      const result = await analyzeExtensionSafety(paths, exempt);
      assertEquals(result.errors, []);
    },
  );
});

Deno.test("analyzeExtensionSafety: extensionless file passes when exempt", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const binPath = join(tmpDir, "mudroom");
    await Deno.writeTextFile(
      binPath,
      "#!/bin/bash\nexec swamp model method run\n",
    );
    const exempt = new Set([binPath]);
    const result = await analyzeExtensionSafety([binPath], exempt);
    assertEquals(result.errors, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("analyzeExtensionSafety: extensionless file rejected when not exempt", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const binPath = join(tmpDir, "mudroom");
    await Deno.writeTextFile(binPath, "#!/bin/bash\n");
    const result = await analyzeExtensionSafety([binPath]);
    assertEquals(result.errors.length, 1);
    assertEquals(result.errors[0].message.includes("not allowed"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("analyzeExtensionSafety: exempt files still checked for hidden names", async () => {
  await withTempFiles(
    { ".hidden": "secret\n" },
    async (_dir, paths) => {
      const exempt = new Set(paths);
      const result = await analyzeExtensionSafety(paths, exempt);
      assertEquals(result.errors.length, 1);
      assertEquals(result.errors[0].message.includes("Hidden files"), true);
    },
  );
});

Deno.test("analyzeExtensionSafety: exempt files still checked for size limit", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const bigFile = join(tmpDir, "big.bin");
    await Deno.writeFile(bigFile, new Uint8Array(1_100_000));
    const exempt = new Set([bigFile]);
    const result = await analyzeExtensionSafety([bigFile], exempt);
    assertEquals(
      result.errors.some((e) => e.message.includes("exceeds maximum")),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ── Content rule framework tests ─────────────────────────────────────

Deno.test("analyzeExtensionSafety: content rule fires on matching file extension", async () => {
  const rule: ContentRule = {
    id: "test-rule",
    severity: "warning",
    fileExtensions: new Set([".md"]),
    detect: (content) => content.includes("SECRET") ? ["Found SECRET"] : [],
  };
  await withTempFiles(
    { "README.md": "Contains SECRET value" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths, undefined, [rule]);
      assertEquals(result.warnings.length, 1);
      assertEquals(result.warnings[0].message, "Found SECRET");
    },
  );
});

Deno.test("analyzeExtensionSafety: content rule does not fire on non-matching extension", async () => {
  const rule: ContentRule = {
    id: "md-only",
    severity: "warning",
    fileExtensions: new Set([".md"]),
    detect: () => ["always fires"],
  };
  await withTempFiles(
    { "config.json": '{"key": "value"}' },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths, undefined, [rule]);
      assertEquals(result.warnings, []);
    },
  );
});

Deno.test("analyzeExtensionSafety: content rule with error severity routes to errors", async () => {
  const rule: ContentRule = {
    id: "blocker",
    severity: "error",
    fileExtensions: new Set([".md"]),
    detect: () => ["blocked"],
  };
  await withTempFiles(
    { "README.md": "anything" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths, undefined, [rule]);
      assertEquals(result.errors.length, 1);
      assertEquals(result.errors[0].message, "blocked");
      assertEquals(result.warnings, []);
    },
  );
});

Deno.test("analyzeExtensionSafety: content rules do not run on .ts files", async () => {
  const rule: ContentRule = {
    id: "no-ts",
    severity: "warning",
    fileExtensions: new Set([".ts"]),
    detect: () => ["should not appear"],
  };
  await withTempFiles(
    { "model.ts": "export const x = 1;\n" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths, undefined, [rule]);
      assertEquals(result.warnings, []);
    },
  );
});

// ── IPv4 address detection tests ─────────────────────────────────────

Deno.test("analyzeExtensionSafety: warns on RFC 1918 IP in .md", async () => {
  await withTempFiles(
    { "README.md": "Connect to host: 10.0.1.50\n" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors, []);
      assertEquals(result.warnings.length, 1);
      assertEquals(result.warnings[0].message.includes("10.0.1.50"), true);
      assertEquals(
        result.warnings[0].message.includes("RFC 5737"),
        true,
      );
    },
  );
});

Deno.test("analyzeExtensionSafety: warns on RFC 1918 IP in .txt", async () => {
  await withTempFiles(
    { "notes.txt": "Server at 192.168.1.100\n" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.warnings.length, 1);
      assertEquals(
        result.warnings[0].message.includes("192.168.1.100"),
        true,
      );
    },
  );
});

Deno.test("analyzeExtensionSafety: RFC 5737 documentation IPs pass clean", async () => {
  await withTempFiles(
    {
      "README.md":
        "Example: 192.0.2.1\nAnother: 198.51.100.5\nThird: 203.0.113.10\n",
    },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.warnings, []);
    },
  );
});

Deno.test("analyzeExtensionSafety: loopback and unspecified IPs pass clean", async () => {
  await withTempFiles(
    { "README.md": "Loopback: 127.0.0.1\nBind: 0.0.0.0\n" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.warnings, []);
    },
  );
});

Deno.test("analyzeExtensionSafety: link-local IPs pass clean", async () => {
  await withTempFiles(
    { "README.md": "Link-local: 169.254.1.1\n" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.warnings, []);
    },
  );
});

Deno.test("analyzeExtensionSafety: clean .md without IPs passes", async () => {
  await withTempFiles(
    { "README.md": "# My Extension\n\nThis does things.\n" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.errors, []);
      assertEquals(result.warnings, []);
    },
  );
});

Deno.test("analyzeExtensionSafety: multiple IPs in one .md produce one warning", async () => {
  await withTempFiles(
    { "README.md": "Host: 10.0.1.50\nJump: 172.16.0.1\nSubnet: 192.168.0.0\n" },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(result.warnings.length, 1);
      assertEquals(result.warnings[0].message.includes("10.0.1.50"), true);
      assertEquals(result.warnings[0].message.includes("172.16.0.1"), true);
      assertEquals(result.warnings[0].message.includes("192.168.0.0"), true);
    },
  );
});

Deno.test("analyzeExtensionSafety: IP detection does not fire on .ts files", async () => {
  await withTempFiles(
    { "model.ts": 'const host = "10.0.1.50";\n' },
    async (_dir, paths) => {
      const result = await analyzeExtensionSafety(paths);
      assertEquals(
        result.warnings.filter((w) => w.message.includes("IPv4")).length,
        0,
      );
    },
  );
});
