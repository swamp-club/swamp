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

/**
 * Regression test for the lazy-extension-type path of the secrets-at-rest guard
 * (swamp-club#480 follow-up, swamp-club#484).
 *
 * The #480 fix added a chokepoint in `YamlDefinitionRepository.save()` that
 * refuses a literal value for a `{ sensitive: true }` global argument. It
 * resolves the type schema via the model registry. For an **extension type**
 * the registry only lazy-registers it, and `model edit` never pre-loads the
 * registry — so `modelRegistry.get(type)` returned undefined, the guard was
 * silently skipped, and a literal secret leaked to disk. The fix promotes the
 * lazy type (`ensureTypeLoaded` + an `ensureLoaded` fallback) before the guard.
 *
 * The existing unit/integration coverage registers types via `defineModel`,
 * which eagerly populates the registry, so `get()` succeeds and the lazy
 * fallback is never exercised. This test closes that gap: it source-mounts a
 * REAL extension model (loaded lazily via the bundle catalog) with a sensitive
 * global argument, seeds a definition holding a safe `vault.get(...)`
 * expression, then drives `model edit` via stdin to swap in a literal secret —
 * and asserts the write is refused and nothing leaks.
 *
 * Each `runCliCommand` is a separate subprocess with a fresh module-level
 * registry, so the `model edit` process genuinely starts with the type
 * unresolved — exactly the condition the original defect hid in.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { initializeTestRepo, runCliCommand } from "./test_helpers.ts";

const EXT_TYPE = "@user/sensitive-lazy-edit-it";

// A real, bundleable extension model with a sensitive global argument. Loaded
// lazily via the bundle catalog (source-mounted), NOT via defineModel — so the
// registry only knows it as a lazy entry until promoted.
const SENSITIVE_LAZY_MODEL = `
import { z } from "npm:zod@4";

export const model = {
  type: "${EXT_TYPE}",
  version: "2026.01.01.1",
  globalArguments: z.object({
    apiKey: z.string().meta({ sensitive: true }),
    region: z.string(),
  }),
  methods: {
    run: {
      description: "Run",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

const VAULT_EXPR = "${{ vault.get('creds', 'apiKey') }}";
// A distinctive literal that must never reach disk.
const LITERAL_SENTINEL = "SUPERSECRET_LAZY_EDIT_SENTINEL_4f1a";

/** Recursively collects the text of every file under `dir`. */
async function readAllFiles(dir: string): Promise<string> {
  let combined = "";
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      combined += await readAllFiles(path);
    } else if (entry.isFile) {
      try {
        combined += await Deno.readTextFile(path);
      } catch {
        // Binary or unreadable (e.g. sqlite) — irrelevant for a cleartext leak.
      }
    }
  }
  return combined;
}

Deno.test("Integration: model edit refuses a literal sensitive global arg on a lazily-loaded extension type", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_it_sensitive_lazy_edit_",
  });
  const extDir = await Deno.makeTempDir({
    prefix: "swamp_it_sensitive_lazy_ext_",
  });
  try {
    await initializeTestRepo(repoDir);

    // Source-mount the extension model (no deno.json — bundled on demand).
    const modelsDir = join(extDir, "models");
    await ensureDir(modelsDir);
    await Deno.writeTextFile(
      join(modelsDir, "sensitive_lazy_edit_it.ts"),
      SENSITIVE_LAZY_MODEL,
    );
    await Deno.writeTextFile(
      join(repoDir, ".swamp-sources.yaml"),
      stringifyYaml({ sources: [{ path: extDir }] } as Record<string, unknown>),
    );

    // --- Seed: create a definition holding a safe vault expression. ---
    // `model create` loads the registry eagerly; succeeding here also serves as
    // the precondition that the extension type loads (no silent bundle failure
    // that could otherwise masquerade as the guard firing later).
    const create = await runCliCommand(
      [
        "model",
        "create",
        EXT_TYPE,
        "leaky-edit",
        "--global-arg",
        `apiKey=${VAULT_EXPR}`,
        "--global-arg",
        "region=us-east-1",
      ],
      repoDir,
    );
    assertEquals(
      create.code,
      0,
      `Seed create failed:\nstdout=${create.stdout}\nstderr=${create.stderr}`,
    );

    // Precondition: the vault expression was persisted; the sentinel is absent.
    // Match the quote-agnostic marker — YAML escapes the inner single quotes.
    const afterSeed = await readAllFiles(join(repoDir, "models"));
    assertStringIncludes(
      afterSeed,
      "vault.get(",
      "Seed definition must persist the vault expression verbatim",
    );

    // --- The lazy-path attack: model edit (stdin) swaps in a literal secret. ---
    // A fresh subprocess: the registry is empty until save() resolves the type.
    const editYaml = stringifyYaml({
      type: EXT_TYPE,
      typeVersion: "2026.01.01.1",
      name: "leaky-edit",
      version: 1,
      globalArguments: {
        apiKey: LITERAL_SENTINEL,
        region: "us-east-1",
      },
    } as Record<string, unknown>);

    const edit = await runCliCommand(
      ["model", "edit", "leaky-edit"],
      repoDir,
      editYaml,
    );

    // The edit must be refused...
    assertEquals(
      edit.code === 0,
      false,
      `model edit should have failed but exited 0:\nstdout=${edit.stdout}\nstderr=${edit.stderr}`,
    );
    // ...for the SPECIFIC reason (not an unrelated lookup/parse failure).
    assertStringIncludes(
      `${edit.stdout}\n${edit.stderr}`,
      "marked sensitive and cannot be set to a literal value",
      "Refusal must be the sensitive-arg guard, not a different error",
    );

    // Nothing leaked: the literal must appear nowhere under the repo, and the
    // on-disk definition must still hold the original vault expression.
    const afterEdit = await readAllFiles(repoDir);
    assertEquals(
      afterEdit.includes(LITERAL_SENTINEL),
      false,
      "Literal sensitive value must not be written anywhere on disk",
    );
    assertStringIncludes(
      await readAllFiles(join(repoDir, "models")),
      "vault.get(",
      "On-disk definition must remain the safe vault expression after refusal",
    );
  } finally {
    try {
      await Deno.remove(repoDir, { recursive: true });
    } catch { /* EBUSY from sqlite — temp dir is ephemeral, OS reclaims */ }
    try {
      await Deno.remove(extDir, { recursive: true });
    } catch { /* best-effort cleanup */ }
  }
});
