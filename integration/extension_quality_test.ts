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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { CLI_ARGS } from "./test_helpers.ts";

const PROJECT_ROOT = Deno.cwd();

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [...CLI_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd: PROJECT_ROOT,
    env: { ...Deno.env.toObject(), SWAMP_NO_TELEMETRY: "1" },
  });
  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

/**
 * Parse the first top-level JSON object from a string. When the CLI
 * exits non-zero in JSON mode, it prints the score object followed by
 * an error object — tests care about the score and want to ignore the
 * trailing error.
 */
// deno-lint-ignore no-explicit-any
function parseFirstJson(stdout: string): any {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        return JSON.parse(stdout.slice(start, i + 1));
      }
    }
  }
  throw new Error(`No complete JSON object in output: ${stdout}`);
}

async function initTempRepo(): Promise<string> {
  const tmpDir = await Deno.makeTempDir();
  await runCli(["init", tmpDir]);
  return tmpDir;
}

/**
 * Build a minimal, well-documented model suitable for earning every
 * rubric factor. Writes one model file with an exported function that
 * has a JSDoc comment AND an explicit return type, plus a README long
 * enough for `rich-readme` and a LICENSE file.
 */
async function writeDocumentedExtension(
  tmpDir: string,
  overrides: {
    description?: string;
    repository?: string;
    platforms?: string[];
    writeReadme?: boolean;
    writeLicense?: boolean;
  } = {},
): Promise<string> {
  const modelsDir = join(tmpDir, "extensions", "models");
  await Deno.mkdir(modelsDir, { recursive: true });

  // Well-documented model: module doc + JSDoc on every export +
  // explicit return types. Passes `deno doc --lint` and contributes
  // documented symbols.
  await Deno.writeTextFile(
    join(modelsDir, "model.ts"),
    `/**
 * A sample model for rubric integration testing.
 *
 * @module
 */

/**
 * Adds two numbers.
 */
export function add(a: number, b: number): number {
  return a + b;
}

/**
 * Subtracts two numbers.
 */
export function sub(a: number, b: number): number {
  return a - b;
}
`,
  );

  if (overrides.writeReadme !== false) {
    // README ≥500 chars with ≥2 fenced code blocks earns has-readme
    // (2) + readme-example (1) + rich-readme (1).
    await Deno.writeTextFile(
      join(tmpDir, "README.md"),
      `# Sample Extension

This extension demonstrates the rubric integration test fixture. It
ships a trivial model that earns every client-detectable factor so we
can assert a perfect score against the opportunistic package cache and
the deno-doc pipeline.

## Usage

\`\`\`ts
import { add } from "./model.ts";
console.log(add(1, 2));
\`\`\`

## Notes

\`\`\`yaml
name: "@test/sample"
version: "2026.02.26.1"
\`\`\`

Plenty of prose here so the README clears the 500-character floor that
the rich-readme factor enforces. Writing lorem-ipsum-ish prose to push
past the floor without blowing the fixture up.
`,
    );
  }

  if (overrides.writeLicense !== false) {
    await Deno.writeTextFile(join(tmpDir, "LICENSE.txt"), "MIT\n");
  }

  const manifest: Record<string, unknown> = {
    manifestVersion: 1,
    name: "@test/sample",
    version: "2026.02.26.1",
    description: overrides.description ?? "A sample extension for testing",
    models: ["model.ts"],
    platforms: overrides.platforms ?? ["linux", "darwin"],
    additionalFiles: [
      ...(overrides.writeReadme !== false ? ["README.md"] : []),
      ...(overrides.writeLicense !== false ? ["LICENSE.txt"] : []),
    ],
  };
  if (overrides.repository !== undefined) {
    manifest.repository = overrides.repository;
  } else {
    manifest.repository = "https://github.com/test/sample";
  }

  const manifestPath = join(tmpDir, "manifest.yaml");
  await Deno.writeTextFile(manifestPath, stringifyYaml(manifest));
  return manifestPath;
}

Deno.test(
  "extension quality: fully-documented extension scores 14/14 (100%)",
  async () => {
    const tmpDir = await initTempRepo();
    try {
      const manifestPath = await writeDocumentedExtension(tmpDir);

      const { code, stdout, stderr } = await runCli([
        "extension",
        "quality",
        manifestPath,
        "--repo-dir",
        tmpDir,
        "--json",
        "--no-color",
      ]);

      if (code !== 0) {
        throw new Error(
          `quality command failed (code ${code})\nstdout: ${stdout}\nstderr: ${stderr}`,
        );
      }
      const parsed = parseFirstJson(stdout);
      assertEquals(parsed.status, "passed");
      assertEquals(parsed.rubricVersion, 3);
      assertEquals(parsed.earnedPoints, 14);
      assertEquals(parsed.maxEarnablePoints, 14);
      assertEquals(parsed.percentage, 100);
      assertEquals(parsed.allPassed, true);

      // Every factor must be "earned" — catches any regression where a
      // specific factor's pass logic drifts from the server.
      for (const f of parsed.factors) {
        assertEquals(f.status, "earned", `factor ${f.id} not earned`);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extension quality: bad manifest fails targeted factors",
  async () => {
    const tmpDir = await initTempRepo();
    try {
      // Empty description, self-hosted repo, single platform — each of
      // these should miss a specific factor; the rest should still
      // earn.
      const manifestPath = await writeDocumentedExtension(tmpDir, {
        description: "",
        repository: "https://git.company.com/x/y",
        platforms: ["linux"],
      });

      const { code, stdout } = await runCli([
        "extension",
        "quality",
        manifestPath,
        "--repo-dir",
        tmpDir,
        "--json",
        "--no-color",
      ]);

      // Exit non-zero since factors missed.
      assertEquals(code !== 0, true);
      const parsed = parseFirstJson(stdout);
      assertEquals(parsed.allPassed, false);

      const statusById = new Map<string, string>(
        parsed.factors.map((f: { id: string; status: string }) => [
          f.id,
          f.status,
        ]),
      );
      assertEquals(statusById.get("description"), "missing");
      assertEquals(statusById.get("repository-verified"), "missing");
      // Still-earned controls:
      assertEquals(statusById.get("has-readme"), "earned");
      assertEquals(statusById.get("has-license"), "earned");
      assertEquals(statusById.get("platforms"), "earned");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extension quality: missing README fails has-readme and readme-example",
  async () => {
    const tmpDir = await initTempRepo();
    try {
      const manifestPath = await writeDocumentedExtension(tmpDir, {
        writeReadme: false,
      });

      const { code, stdout } = await runCli([
        "extension",
        "quality",
        manifestPath,
        "--repo-dir",
        tmpDir,
        "--json",
        "--no-color",
      ]);

      assertEquals(code !== 0, true);
      const parsed = parseFirstJson(stdout);
      const byId = new Map<string, { status: string }>(
        parsed.factors.map((f: { id: string; status: string }) => [f.id, f]),
      );
      // has-readme is true when README OR every entrypoint has
      // module-level doc. Our fixture has module docs, so has-readme
      // still earns. But readme-example and rich-readme both fail.
      assertEquals(
        byId.get("has-readme")?.status,
        "earned",
        "has-readme should be earned via module-level doc",
      );
      assertEquals(
        byId.get("readme-example")?.status,
        "missing",
        "readme-example should be missing when no README",
      );
      assertEquals(
        byId.get("rich-readme")?.status,
        "missing",
        "rich-readme should be missing when no README",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extension quality: cache populated by quality is reused on second run",
  async () => {
    const tmpDir = await initTempRepo();
    try {
      const manifestPath = await writeDocumentedExtension(tmpDir);

      const first = await runCli([
        "extension",
        "quality",
        manifestPath,
        "--repo-dir",
        tmpDir,
        "--json",
        "--no-color",
      ]);
      if (first.code !== 0) {
        throw new Error(
          `first quality run failed: ${first.stderr}\n${first.stdout}`,
        );
      }
      const firstParsed = JSON.parse(first.stdout);
      assertEquals(firstParsed.cacheHit, false);

      const cacheDir = join(
        tmpDir,
        ".swamp",
        "cache",
        "packages",
        firstParsed.cacheHash,
      );
      const archivePath = join(cacheDir, "extension.tar.gz");
      const archiveStat = await Deno.stat(archivePath);
      assert(archiveStat.isFile, "cache entry should hold a tarball");

      const second = await runCli([
        "extension",
        "quality",
        manifestPath,
        "--repo-dir",
        tmpDir,
        "--json",
        "--no-color",
      ]);
      if (second.code !== 0) {
        throw new Error(
          `second quality run failed: ${second.stderr}\n${second.stdout}`,
        );
      }
      const secondParsed = JSON.parse(second.stdout);
      assertEquals(secondParsed.cacheHit, true);
      assertEquals(secondParsed.cacheHash, firstParsed.cacheHash);
      assertEquals(secondParsed.earnedPoints, firstParsed.earnedPoints);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extension quality: changing a source file invalidates the cache",
  async () => {
    const tmpDir = await initTempRepo();
    try {
      const manifestPath = await writeDocumentedExtension(tmpDir);

      const first = await runCli([
        "extension",
        "quality",
        manifestPath,
        "--repo-dir",
        tmpDir,
        "--json",
        "--no-color",
      ]);
      const firstHash = JSON.parse(first.stdout).cacheHash as string;

      // Mutate a source file; a re-run must compute a different hash
      // and fully re-package.
      await Deno.writeTextFile(
        join(tmpDir, "extensions", "models", "model.ts"),
        `/**
 * Different file now.
 *
 * @module
 */

/** A different exported function. */
export function mul(a: number, b: number): number {
  return a * b;
}
`,
      );

      const second = await runCli([
        "extension",
        "quality",
        manifestPath,
        "--repo-dir",
        tmpDir,
        "--json",
        "--no-color",
      ]);
      const secondParsed = JSON.parse(second.stdout);
      const secondHash = secondParsed.cacheHash as string;

      assertEquals(
        secondParsed.cacheHit,
        false,
        "changed source should miss the cache",
      );
      assert(
        firstHash !== secondHash,
        "cache hash should change when source changes",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test("extension quality: log mode renders per-factor lines", async () => {
  const tmpDir = await initTempRepo();
  try {
    const manifestPath = await writeDocumentedExtension(tmpDir);

    const { code, stdout, stderr } = await runCli([
      "extension",
      "quality",
      manifestPath,
      "--repo-dir",
      tmpDir,
      "--log",
      "--no-color",
    ]);

    if (code !== 0) {
      throw new Error(`log-mode quality failed: ${stderr}\n${stdout}`);
    }
    // The renderer logs to stderr via logtape; check both streams.
    const combined = stdout + stderr;
    assertStringIncludes(combined, "Rubric v3");
    assertStringIncludes(combined, "has-readme");
    assertStringIncludes(combined, "fast-check");
    assertStringIncludes(combined, "symbols-docs");
    assertStringIncludes(combined, "repository-verified");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
