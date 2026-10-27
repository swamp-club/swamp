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
 * Pull scans the bundles an extension runs, not only its source copy
 * (swamp-club#3383). Push builds each bundle from the sources it ships, so
 * an archive whose bundle holds code its source copy lacks can only be
 * hand-built; that is the case this covers. Wires the CLI's pull path
 * (`pullExtension` over `createExtensionPullDeps` and the real registry
 * client) to a registry on a port-0 server, and renders the outcome as the
 * CLI does in log and JSON modes.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs";
import { getLogger } from "@logtape/logtape";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { pullExtension } from "../src/cli/commands/extension_pull.ts";
import { createExtensionPullDeps } from "../src/libswamp/extensions/pull.ts";
import {
  exitCodeForError,
  renderError,
} from "../src/presentation/output/error_output.ts";
import { computeChecksum } from "../src/domain/models/checksum.ts";
import { UserError } from "../src/domain/errors.ts";
import { buildRawTarGz } from "../src/infrastructure/archive/raw_tar_test_helpers.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";

import "../src/domain/models/models.ts";

await initializeLogging({});

const V1 = "2026.10.26.1";
const V2 = "2026.10.26.2";
const ESC = "\x1b";

const denoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

/** A registry serving each archive in `versions`, the last one as latest. */
async function serveRegistry(
  name: string,
  versions: Record<string, Uint8Array<ArrayBuffer>>,
) {
  const checksums: Record<string, string> = {};
  for (const [version, archive] of Object.entries(versions)) {
    checksums[version] = await computeChecksum(archive);
  }
  const latest = Object.keys(versions).at(-1)!;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    (req) => {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      if (path === `/api/v1/extensions/${name}`) {
        return Response.json({ name, description: "", latestVersion: latest });
      }
      if (path === `/api/v1/extensions/${name}/latest`) {
        return Response.json({ latestVersion: latest });
      }
      for (const version of Object.keys(versions)) {
        if (path === `/api/v1/extensions/${name}@${version}/download`) {
          return new Response(null, {
            status: 302,
            headers: { location: `${url.origin}/archive/${version}` },
          });
        }
        if (path === `/archive/${version}`) {
          return new Response(versions[version]);
        }
        if (path === `/api/v1/extensions/${name}@${version}/checksum`) {
          return Response.json({ checksum: checksums[version] });
        }
      }
      return new Response(null, { status: 404 });
    },
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    async [Symbol.asyncDispose]() {
      await server.shutdown();
    },
  };
}

/** A model whose behavior answers `label`; imports `imports` first. */
function modelSource(name: string, label: string, imports = ""): string {
  return [
    imports,
    'import { z } from "npm:zod@4";',
    "export const model = {",
    `  type: "${name}",`,
    `  version: "${V1}",`,
    "  globalArguments: z.object({}),",
    "  resources: {},",
    "  methods: {",
    "    noop: {",
    `      description: "${label}",`,
    "      arguments: z.object({}),",
    "      execute: async () => ({ dataHandles: [] }),",
    "    },",
    "  },",
    "};",
    "",
  ].join("\n");
}

/** A model extension archive at `version` holding `files` under `extension/`. */
async function modelArchive(
  name: string,
  version: string,
  files: Record<string, string>,
) {
  const dirs = new Set<string>(["extension/"]);
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(`extension/${parts.slice(0, i).join("/")}/`);
    }
  }
  return await buildRawTarGz([
    ...[...dirs].sort().map((path) => ({ path, typeflag: "5" as const })),
    {
      path: "extension/manifest.yaml",
      typeflag: "0",
      body: [
        "manifestVersion: 1",
        `name: "${name}"`,
        `version: "${version}"`,
        "models:",
        "  - thing.ts",
      ].join("\n"),
    },
    ...Object.entries(files).map(([path, body]) => ({
      path: `extension/${path}`,
      typeflag: "0" as const,
      body,
    })),
  ]);
}

/** Each call `run` makes to `console[stream]`, its arguments joined. */
async function captureCalls(
  stream: "error" | "log",
  run: () => void | Promise<void>,
): Promise<string[]> {
  const calls: string[] = [];
  const original = console[stream];
  console[stream] = (...args: unknown[]) => calls.push(args.join(" "));
  try {
    await run();
  } finally {
    console[stream] = original;
  }
  return calls;
}

async function capture(
  stream: "error" | "log",
  run: () => void | Promise<void>,
): Promise<string> {
  return (await captureCalls(stream, run)).join("\n");
}

/** Every path under `dir`. */
async function treeOf(dir: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of walk(dir, { followSymlinks: false })) {
    paths.push(entry.path);
  }
  return paths.sort();
}

/** A fresh repo dir under a temp root, removed when disposed. */
async function tempRepo() {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-pull-bundle-safety-" }),
  );
  const repoDir = join(root, "repo");
  await Deno.mkdir(repoDir);
  return {
    root,
    repoDir,
    async [Symbol.asyncDispose]() {
      await Deno.remove(root, { recursive: true }).catch((error) => {
        if (Deno.build.os !== "windows") throw error;
      });
    },
  };
}

/**
 * Pulls the latest version of `name` from `registryUrl` into `repoDir`.
 * With `phase8`, routes through the install service, as the CLI does, so
 * the bundles are rebuilt and indexed.
 */
async function pull(
  name: string,
  registryUrl: string,
  repoDir: string,
  outputMode: "log" | "json",
  options: { phase8?: boolean; version?: string } = {},
): Promise<unknown> {
  const lockfilePath = join(repoDir, "upstream_extensions.json");
  const skillsDirs = [join(repoDir, ".claude", "skills")];
  const deps = await createExtensionPullDeps(
    registryUrl,
    lockfilePath,
    skillsDirs,
    repoDir,
  );
  let catalog: ExtensionCatalogStore | undefined;
  let repository: ExtensionRepository | undefined;
  if (options.phase8) {
    await Deno.mkdir(swampPath(repoDir), { recursive: true });
    catalog = new ExtensionCatalogStore(
      swampPath(repoDir, "_extension_catalog.db"),
    );
    repository = new ExtensionRepository({
      catalog,
      lockfileRepository: deps.lockfileRepository,
      repoRoot: repoDir,
    });
  }
  try {
    await pullExtension({ name, version: options.version ?? null }, {
      ...deps,
      logger: getLogger(["test"]),
      skillsDirs,
      repoDir,
      force: false,
      outputMode,
      alreadyPulled: new Set(),
      depth: 0,
      // An upgrade asks before replacing the installed version.
      confirm: () => Promise.resolve(true),
      ...(repository ? { denoRuntime, repository } : {}),
    });
    return undefined;
  } catch (error) {
    return error;
  } finally {
    catalog?.close();
  }
}

/** The message a refused pull prints, in `outputMode`. */
async function refusalMessage(
  thrown: unknown,
  outputMode: "log" | "json",
): Promise<string> {
  assert(thrown instanceof UserError, String(thrown));
  assertEquals(exitCodeForError(thrown), 1);
  const stderr = await capture("error", () => renderError(thrown, outputMode));
  return outputMode === "json" ? JSON.parse(stderr).error as string : stderr;
}

for (const outputMode of ["log", "json"] as const) {
  Deno.test(`extension pull (${outputMode}): a bundle holding eval its source copy lacks is refused, naming the module, and nothing lands (swamp-club#3383)`, async () => {
    await using repo = await tempRepo();
    const name = `@test/bundle-only-${crypto.randomUUID().slice(0, 8)}`;
    await using registry = await serveRegistry(name, {
      [V1]: await modelArchive(name, V1, {
        "models/thing.ts": modelSource(name, "clean"),
        "bundles/thing.js": [
          "// extensions/models/_lib/helper.ts",
          "const run = (s) => eval(s);",
          "// extensions/models/thing.ts",
          'export const model = { type: "thing", run };',
        ].join("\n"),
      }),
    });
    const before = await treeOf(repo.root);

    const message = await refusalMessage(
      await pull(name, registry.url, repo.repoDir, outputMode),
      outputMode,
    );
    assertStringIncludes(
      message,
      "Extension bundle has safety errors. Install aborted.",
    );
    assertStringIncludes(
      message,
      "bundles/thing.js line 2: Module extensions/models/_lib/helper.ts " +
        "contains eval()",
    );
    // Nothing landed: no install root, no lockfile.
    assertEquals(
      (await treeOf(repo.root)).filter((p) => !before.includes(p)),
      [],
    );
  });

  Deno.test(`extension pull (${outputMode}): a module comment's ESC sequence prints escaped (swamp-club#3383)`, async () => {
    await using repo = await tempRepo();
    const name = `@test/bundle-esc-${crypto.randomUUID().slice(0, 8)}`;
    await using registry = await serveRegistry(name, {
      [V1]: await modelArchive(name, V1, {
        "models/thing.ts": modelSource(name, "clean"),
        "bundles/thing.js": [
          `// extensions/models/${ESC}[31mred.ts`,
          "const run = (s) => eval(s);",
        ].join("\n"),
      }),
    });
    const thrown = await pull(name, registry.url, repo.repoDir, outputMode);
    assert(thrown instanceof UserError, String(thrown));
    const stderr = await capture(
      "error",
      () => renderError(thrown, outputMode),
    );
    assertStringIncludes(
      outputMode === "json" ? JSON.parse(stderr).error : stderr,
      "Module extensions/models/\\x1b[31mred.ts contains eval()",
    );
    assertEquals(stderr.includes(`${ESC}[31mred`), false, stderr);
  });
}

Deno.test("extension pull: a bundle without module comments holding eval is refused (swamp-club#3383)", async () => {
  await using repo = await tempRepo();
  const name = `@test/bundle-bare-${crypto.randomUUID().slice(0, 8)}`;
  await using registry = await serveRegistry(name, {
    [V1]: await modelArchive(name, V1, {
      "models/thing.ts": modelSource(name, "clean"),
      "bundles/thing.js": "export const run = (s) => eval(s);\n",
    }),
  });
  const message = await refusalMessage(
    await pull(name, registry.url, repo.repoDir, "log"),
    "log",
  );
  assertStringIncludes(
    message,
    "The bundle has no module comments, so all of its code counts as the " +
      "extension's own; it contains eval()",
  );
});

Deno.test("extension pull: a clean archive pulls as before, with no warning (swamp-club#3383)", async () => {
  await using repo = await tempRepo();
  const name = `@test/bundle-clean-${crypto.randomUUID().slice(0, 8)}`;
  await using registry = await serveRegistry(name, {
    [V1]: await modelArchive(name, V1, {
      "models/thing.ts": modelSource(name, "clean"),
      "bundles/thing.js": `// extensions/models/thing.ts\n${
        modelSource(name, "clean")
      }`,
    }),
  });
  let thrown: unknown;
  const stdout = await capture("log", async () => {
    thrown = await pull(name, registry.url, repo.repoDir, "json");
  });
  assertEquals(thrown, undefined);
  assertEquals(stdout.includes('"warnings"'), false, stdout);
  const lockfile = await Deno.readTextFile(
    join(repo.repoDir, "upstream_extensions.json"),
  );
  assertStringIncludes(lockfile, name);
});

Deno.test("extension pull: eval in a dependency's code pulls, with one warning naming the dependency (swamp-club#3383)", async () => {
  await using repo = await tempRepo();
  const name = `@test/bundle-dep-${crypto.randomUUID().slice(0, 8)}`;
  await using registry = await serveRegistry(name, {
    [V1]: await modelArchive(name, V1, {
      "models/thing.ts": modelSource(name, "clean"),
      "bundles/thing.js": [
        "// ../../.swamp/deno-cache/npm/registry.npmjs.org/dep/1.0.0/index.js",
        "const f = new Function('return 1');",
        "// extensions/models/thing.ts",
        'export const model = { type: "thing", f };',
      ].join("\n"),
    }),
  });
  let thrown: unknown;
  // JSON mode prints each document with one console.log call.
  const documents = await captureCalls("log", async () => {
    thrown = await pull(name, registry.url, repo.repoDir, "json");
  });
  assertEquals(thrown, undefined);
  const warnings = documents.map((doc) => JSON.parse(doc)).find((doc) =>
    doc.warnings
  )?.warnings;
  assertEquals(warnings, [{
    file: "npm:dep/1.0.0/index.js",
    message: "Dependency code uses eval() or new Function(), in " +
      "bundles/thing.js. Findings in dependency code are reported, not " +
      "refused.",
  }]);
});

/**
 * An archive at `version` whose bundle is clean but whose model imports a
 * module under `files/`, which pull's source scan does not cover, holding
 * eval. Only the bundle pull rebuilds from the source holds it.
 */
async function rebuildOnlyArchive(name: string, version: string) {
  return await modelArchive(name, version, {
    "models/thing.ts": modelSource(
      name,
      "rebuilt",
      'import { run } from "../files/helper.js";\nconsole.log(run);',
    ),
    "files/helper.js": "export const run = (s) => eval(s);\n",
    "bundles/thing.js": `// extensions/models/thing.ts\n${
      modelSource(name, "clean")
    }`,
  });
}

Deno.test("extension pull: a rebuilt bundle pulling in eval from an unscanned module is refused before it runs, and nothing stays installed (swamp-club#3383)", async () => {
  await using repo = await tempRepo();
  const name = `@test/bundle-rebuilt-${crypto.randomUUID().slice(0, 8)}`;
  await using registry = await serveRegistry(name, {
    [V1]: await rebuildOnlyArchive(name, V1),
  });
  const message = await refusalMessage(
    await pull(name, registry.url, repo.repoDir, "log", { phase8: true }),
    "log",
  );
  assertStringIncludes(
    message,
    "bundle rebuilt from models/thing.ts line",
  );
  assertStringIncludes(message, "files/helper.js contains eval()");
  assertStringIncludes(message, "The install was rolled back");
  const installed = (await treeOf(repo.repoDir)).filter((p) =>
    p.includes(`pulled-extensions`) && p.endsWith(".ts") ||
    p.endsWith("thing.js")
  );
  assertEquals(installed, []);
  const lockfile = await Deno.readTextFile(
    join(repo.repoDir, "upstream_extensions.json"),
  ).catch(() => "");
  assertEquals(lockfile.includes(name), false, lockfile);
});

Deno.test("extension pull: an upgrade refused in phase 8 leaves the previous version installed (swamp-club#3383)", async () => {
  await using repo = await tempRepo();
  const name = `@test/bundle-upgrade-${crypto.randomUUID().slice(0, 8)}`;
  const v1Bundle = `// extensions/models/thing.ts\n${modelSource(name, "v1")}`;
  await using registry = await serveRegistry(name, {
    [V1]: await modelArchive(name, V1, {
      "models/thing.ts": modelSource(name, "v1"),
      "bundles/thing.js": v1Bundle,
    }),
    [V2]: await rebuildOnlyArchive(name, V2),
  });
  // v1 without phase 8, so no probe host runs; its archive bundle stays.
  assertEquals(
    await pull(name, registry.url, repo.repoDir, "log", { version: V1 }),
    undefined,
  );
  const extRoot = join(swampPath(repo.repoDir, "pulled-extensions"), name);
  const bundlesBefore = (await treeOf(swampPath(repo.repoDir))).filter((p) =>
    p.endsWith("thing.js")
  );
  assertEquals(bundlesBefore.length, 1);

  const message = await refusalMessage(
    await pull(name, registry.url, repo.repoDir, "log", { phase8: true }),
    "log",
  );
  assertStringIncludes(message, "files/helper.js contains eval()");
  assertStringIncludes(message, "The install was rolled back");

  // v1 is back: its source, its bundle (what a later load serves), its
  // lockfile entry, and none of v2's files.
  assertEquals(
    await Deno.readTextFile(join(extRoot, "models", "thing.ts")),
    modelSource(name, "v1"),
  );
  assertEquals(await Deno.readTextFile(bundlesBefore[0]), v1Bundle);
  assertEquals(
    await Deno.stat(join(extRoot, "files", "helper.js")).catch(() => null),
    null,
  );
  const lockfile = JSON.parse(
    await Deno.readTextFile(join(repo.repoDir, "upstream_extensions.json")),
  );
  assertEquals(JSON.stringify(lockfile).includes(V1), true);
  assertEquals(JSON.stringify(lockfile).includes(V2), false);
});
