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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  createAutoResolveInstallerAdapter,
  createAutoResolveOutputAdapter,
} from "../src/cli/auto_resolver_adapters.ts";
import { ExtensionAutoResolver } from "../src/domain/extensions/extension_auto_resolver.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";

// Regression guard for swamp-club issue 1672: when a local source
// extension fails to index (BundleBuildFailed or ValidationFailed),
// the auto-resolver must emit "local_source_failed" — not the
// misleading "collective_not_trusted" — when the type matches the
// failed source's content.

const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/usr/bin/false"),
  getDenoEnv: () => Deno.env.toObject(),
};

Deno.test("integration: auto-resolver emits localSourceFailed when failed local source contains the type", async () => {
  const tmpDir = await Deno.makeTempDir({
    prefix: "swamp_issue_1672_match_",
  });
  try {
    const repoDir = tmpDir;
    await ensureDir(join(repoDir, ".swamp"));
    await ensureDir(join(repoDir, "extensions", "models"));

    const sourceFile = join(
      repoDir,
      "extensions",
      "models",
      "broken_model.ts",
    );
    await Deno.writeTextFile(
      sourceFile,
      `export const model = { type: "@repro/broken-model" };`,
    );

    const catalogPath = join(repoDir, ".swamp", "_extension_catalog.db");
    const catalog = new ExtensionCatalogStore(catalogPath);
    catalog.upsertWithIdentity({
      source_path: sourceFile,
      type_normalized: "",
      kind: "model",
      bundle_path: "",
      version: "0.0.0",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: "",
      state: "BundleBuildFailed",
      last_error: "deno bundle failed: npm dep not found",
      extension_name: "@local/test-repo",
      extension_version: "0.0.0",
    });
    catalog.markPopulated("model");

    const lockfilePath = join(repoDir, "upstream_extensions.json");
    await Deno.writeTextFile(lockfilePath, "{}");
    const lockfileRepository = await LockfileRepository.create(lockfilePath);
    const repository = new ExtensionRepository({
      catalog,
      lockfileRepository,
      repoRoot: repoDir,
    });

    const outputCalls: string[] = [];
    const output = createAutoResolveOutputAdapter("json");
    const wrappedOutput = {
      ...output,
      localSourceFailed(type: string) {
        outputCalls.push(`localSourceFailed:${type}`);
        output.localSourceFailed(type);
      },
      collectiveNotTrusted(collective: string, type: string) {
        outputCalls.push(`collectiveNotTrusted:${collective}:${type}`);
        output.collectiveNotTrusted(collective, type);
      },
    };

    const installer = createAutoResolveInstallerAdapter({
      getExtension: () => Promise.resolve(null),
      downloadArchive: () => Promise.reject(new Error("unreachable")),
      getChecksum: () => Promise.resolve(null),
      lockfilePath,
      repoDir,
      denoRuntime: stubDenoRuntime,
      repository,
    });

    const resolver = new ExtensionAutoResolver({
      allowedCollectives: [],
      extensionLookup: {
        getExtension: () => Promise.resolve(null),
        searchExtensions: () => Promise.resolve({ extensions: [] }),
      },
      extensionInstaller: installer,
      output: wrappedOutput,
    });

    const result = await resolver.resolve("@repro/broken-model");
    assertEquals(result, false);
    assertEquals(outputCalls, [
      "localSourceFailed:@repro/broken-model",
    ]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("integration: auto-resolver emits collectiveNotTrusted when failed local source does NOT contain the type", async () => {
  const tmpDir = await Deno.makeTempDir({
    prefix: "swamp_issue_1672_nomatch_",
  });
  try {
    const repoDir = tmpDir;
    await ensureDir(join(repoDir, ".swamp"));
    await ensureDir(join(repoDir, "extensions", "models"));

    const sourceFile = join(
      repoDir,
      "extensions",
      "models",
      "other_model.ts",
    );
    await Deno.writeTextFile(
      sourceFile,
      `export const model = { type: "@other/something-else" };`,
    );

    const catalogPath = join(repoDir, ".swamp", "_extension_catalog.db");
    const catalog = new ExtensionCatalogStore(catalogPath);
    catalog.upsertWithIdentity({
      source_path: sourceFile,
      type_normalized: "",
      kind: "model",
      bundle_path: "",
      version: "0.0.0",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: "",
      state: "BundleBuildFailed",
      last_error: "deno bundle failed: npm dep not found",
      extension_name: "@local/test-repo",
      extension_version: "0.0.0",
    });
    catalog.markPopulated("model");

    const lockfilePath = join(repoDir, "upstream_extensions.json");
    await Deno.writeTextFile(lockfilePath, "{}");
    const lockfileRepository = await LockfileRepository.create(lockfilePath);
    const repository = new ExtensionRepository({
      catalog,
      lockfileRepository,
      repoRoot: repoDir,
    });

    const outputCalls: string[] = [];
    const output = createAutoResolveOutputAdapter("json");
    const wrappedOutput = {
      ...output,
      localSourceFailed(type: string) {
        outputCalls.push(`localSourceFailed:${type}`);
        output.localSourceFailed(type);
      },
      collectiveNotTrusted(collective: string, type: string) {
        outputCalls.push(`collectiveNotTrusted:${collective}:${type}`);
        output.collectiveNotTrusted(collective, type);
      },
    };

    const installer = createAutoResolveInstallerAdapter({
      getExtension: () => Promise.resolve(null),
      downloadArchive: () => Promise.reject(new Error("unreachable")),
      getChecksum: () => Promise.resolve(null),
      lockfilePath,
      repoDir,
      denoRuntime: stubDenoRuntime,
      repository,
    });

    const resolver = new ExtensionAutoResolver({
      allowedCollectives: [],
      extensionLookup: {
        getExtension: () => Promise.resolve(null),
        searchExtensions: () => Promise.resolve({ extensions: [] }),
      },
      extensionInstaller: installer,
      output: wrappedOutput,
    });

    const result = await resolver.resolve("@unrelated/widget");
    assertEquals(result, false);
    assertEquals(outputCalls, [
      "collectiveNotTrusted:unrelated:@unrelated/widget",
    ]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("integration: auto-resolver emits localSourceFailed for ValidationFailed state too", async () => {
  const tmpDir = await Deno.makeTempDir({
    prefix: "swamp_issue_1672_valfail_",
  });
  try {
    const repoDir = tmpDir;
    await ensureDir(join(repoDir, ".swamp"));
    await ensureDir(join(repoDir, "extensions", "models"));

    const sourceFile = join(
      repoDir,
      "extensions",
      "models",
      "bad_schema.ts",
    );
    await Deno.writeTextFile(
      sourceFile,
      `export const model = { type: "@myns/bad-schema" };`,
    );

    const catalogPath = join(repoDir, ".swamp", "_extension_catalog.db");
    const catalog = new ExtensionCatalogStore(catalogPath);
    catalog.upsertWithIdentity({
      source_path: sourceFile,
      type_normalized: "",
      kind: "model",
      bundle_path: "/some/bundle.js",
      version: "0.0.0",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: "",
      state: "ValidationFailed",
      last_error: "missing required export",
      extension_name: "@local/test-repo",
      extension_version: "0.0.0",
    });
    catalog.markPopulated("model");

    const lockfilePath = join(repoDir, "upstream_extensions.json");
    await Deno.writeTextFile(lockfilePath, "{}");
    const lockfileRepository = await LockfileRepository.create(lockfilePath);
    const repository = new ExtensionRepository({
      catalog,
      lockfileRepository,
      repoRoot: repoDir,
    });

    const outputCalls: string[] = [];
    const output = createAutoResolveOutputAdapter("json");
    const wrappedOutput = {
      ...output,
      localSourceFailed(type: string) {
        outputCalls.push(`localSourceFailed:${type}`);
        output.localSourceFailed(type);
      },
      collectiveNotTrusted(collective: string, type: string) {
        outputCalls.push(`collectiveNotTrusted:${collective}:${type}`);
        output.collectiveNotTrusted(collective, type);
      },
    };

    const installer = createAutoResolveInstallerAdapter({
      getExtension: () => Promise.resolve(null),
      downloadArchive: () => Promise.reject(new Error("unreachable")),
      getChecksum: () => Promise.resolve(null),
      lockfilePath,
      repoDir,
      denoRuntime: stubDenoRuntime,
      repository,
    });

    const resolver = new ExtensionAutoResolver({
      allowedCollectives: [],
      extensionLookup: {
        getExtension: () => Promise.resolve(null),
        searchExtensions: () => Promise.resolve({ extensions: [] }),
      },
      extensionInstaller: installer,
      output: wrappedOutput,
    });

    const result = await resolver.resolve("@myns/bad-schema");
    assertEquals(result, false);
    assertEquals(outputCalls, [
      "localSourceFailed:@myns/bad-schema",
    ]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
