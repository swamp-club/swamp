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

/**
 * Integration tests for `swamp issue bug|feature|security --extension`.
 *
 * Two tiers of coverage live here:
 *
 *   1. Hermetic tier (always runs) — exercises the refusal paths, which
 *      never need a network or gh install. These tests run in CI to
 *      catch regressions in the local dispatch logic.
 *
 *   2. Live gh tier (gated on environment) — invokes the real `gh`
 *      binary against a throwaway GitHub repo.
 *
 *      Required env vars:
 *        GH_TOKEN         — a PAT or fine-grained token with `issues:
 *                           write` on GH_TEST_REPO.
 *        GH_TEST_REPO     — `owner/repo` of a repository the test can
 *                           write to. Issues created here must be
 *                           cleaned up manually (we don't delete on
 *                           purpose so you can inspect them).
 *
 *      The live tier is skipped via Deno.test's `ignore` option when
 *      either env var is absent, so CI without gh still passes.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { initializeTestRepo, runCliCommand } from "./test_helpers.ts";

/** Writes a pulled-extension manifest at the canonical on-disk location. */
async function writePulledExtension(
  repoDir: string,
  extensionName: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const extDir = join(
    repoDir,
    ".swamp",
    "pulled-extensions",
    extensionName,
  );
  await ensureDir(extDir);
  await Deno.writeTextFile(
    join(extDir, "manifest.yaml"),
    Object.entries(manifest)
      .map(([k, v]) => typeof v === "string" ? `${k}: "${v}"` : `${k}: ${v}`)
      .join("\n") + "\n",
  );

  // Lockfile — extensions/models/upstream_extensions.json.
  const modelsDir = join(repoDir, "extensions", "models");
  await ensureDir(modelsDir);
  const lockfile = join(modelsDir, "upstream_extensions.json");
  const existing = await tryReadJson(lockfile) ?? {};
  existing[extensionName] = {
    version: manifest.version ?? "2026.04.22.1",
    pulledAt: new Date().toISOString(),
  };
  await Deno.writeTextFile(lockfile, JSON.stringify(existing));
}

async function tryReadJson(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null;
  }
}

async function makeTempRepo(): Promise<string> {
  const repo = await Deno.makeTempDir({ prefix: "swamp_issue_ext_" });
  await initializeTestRepo(repo);
  return repo;
}

// ---- Hermetic tier: refusal paths ----

Deno.test("issue bug --extension: refuses not-pulled extension with exact pull command", async () => {
  const repo = await makeTempRepo();
  try {
    const { stdout, code } = await runCliCommand(
      [
        "--json",
        "issue",
        "bug",
        "--extension",
        "@adam/cfgmgmt",
        "--title",
        "t",
        "--body",
        "b",
      ],
      repo,
    );

    assertEquals(code, 0, "refusals must exit 0, not as errors");
    const parsed = JSON.parse(stdout);
    assertEquals(parsed.status, "refused");
    assertEquals(parsed.reason, "not-pulled");
    assertStringIncludes(
      parsed.guidance,
      "swamp extension pull @adam/cfgmgmt",
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("issue bug --extension: refuses no-repository extension pointing at swamp-club extension page", async () => {
  const repo = await makeTempRepo();
  try {
    await writePulledExtension(repo, "@adam/cfgmgmt", {
      manifestVersion: 1,
      name: "@adam/cfgmgmt",
      version: "2026.04.22.1",
      models: "",
    });
    // The stringify above produces "models: " which is invalid — rewrite properly.
    await Deno.writeTextFile(
      join(
        repo,
        ".swamp",
        "pulled-extensions",
        "@adam/cfgmgmt",
        "manifest.yaml",
      ),
      `manifestVersion: 1
name: "@adam/cfgmgmt"
version: "2026.04.22.1"
models:
  - foo.yaml
`,
    );

    const { stdout, code } = await runCliCommand(
      [
        "--json",
        "issue",
        "bug",
        "--extension",
        "@adam/cfgmgmt",
        "--title",
        "t",
        "--body",
        "b",
      ],
      repo,
    );

    assertEquals(code, 0);
    const parsed = JSON.parse(stdout);
    assertEquals(parsed.status, "refused");
    assertEquals(parsed.reason, "no-repository");
    assertStringIncludes(
      parsed.guidance,
      "swamp-club.com/extensions/%40adam%2Fcfgmgmt",
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("issue bug --extension: rejects malformed extension name", async () => {
  const repo = await makeTempRepo();
  try {
    const { code, stderr } = await runCliCommand(
      [
        "issue",
        "bug",
        "--extension",
        "not-a-scoped-name",
        "--title",
        "t",
        "--body",
        "b",
      ],
      repo,
    );
    assertEquals(code !== 0, true);
    // Error text may live in stderr or stdout depending on logger config.
    assertStringIncludes(stderr, "Invalid extension name");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("issue bug --extension conflicts with --email", async () => {
  const repo = await makeTempRepo();
  try {
    const { code, stderr } = await runCliCommand(
      [
        "issue",
        "bug",
        "--extension",
        "@adam/cfgmgmt",
        "--email",
        "--title",
        "t",
        "--body",
        "b",
      ],
      repo,
    );
    assertEquals(code !== 0, true);
    assertStringIncludes(stderr, "cannot be used together");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

// ---- Live gh tier ----

const LIVE_GH_TOKEN = Deno.env.get("GH_TOKEN") ?? Deno.env.get("GITHUB_TOKEN");
const LIVE_TEST_REPO = Deno.env.get("GH_TEST_REPO");
const LIVE_TIER_ENABLED = Boolean(LIVE_GH_TOKEN) && Boolean(LIVE_TEST_REPO);

Deno.test({
  name:
    "issue bug --extension (live gh): files a real issue against GH_TEST_REPO",
  ignore: !LIVE_TIER_ENABLED,
  async fn() {
    const repo = await makeTempRepo();
    try {
      await writePulledExtension(repo, "@testuser/fixture", {
        manifestVersion: 1,
        name: "@testuser/fixture",
        version: "2026.04.22.1",
        repository: `https://github.com/${LIVE_TEST_REPO}`,
        models: [],
      });
      // Rewrite with proper list format.
      await Deno.writeTextFile(
        join(
          repo,
          ".swamp",
          "pulled-extensions",
          "@testuser/fixture",
          "manifest.yaml",
        ),
        `manifestVersion: 1
name: "@testuser/fixture"
version: "2026.04.22.1"
repository: "https://github.com/${LIVE_TEST_REPO}"
models:
  - foo.yaml
`,
      );

      const title = `[swamp-integration-test] ${crypto.randomUUID()}`;
      const { stdout, code } = await runCliCommand(
        [
          "--json",
          "issue",
          "bug",
          "--extension",
          "@testuser/fixture",
          "--title",
          title,
          "--body",
          "Integration test body — close when seen.",
        ],
        repo,
      );

      assertEquals(code, 0);
      const parsed = JSON.parse(stdout);
      assertEquals(parsed.status, "handoff");
      assertEquals(parsed.method, "gh");
      assertEquals(parsed.variant, "issue");
      assertStringIncludes(parsed.url, `github.com/${LIVE_TEST_REPO}/issues/`);
      // Leave the issue open — the user reviewing the test repo closes
      // them manually so they can inspect what was filed.
    } finally {
      await Deno.remove(repo, { recursive: true });
    }
  },
});
