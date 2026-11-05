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
import { extractExtensionNameFromPath } from "./extension_loader.ts";

Deno.test("extractExtensionNameFromPath: scoped extension name", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/@testco/greeter/models/greeter/model.ts",
    "/repo",
  );
  assertEquals(result, "@testco/greeter");
});

Deno.test("extractExtensionNameFromPath: unscoped extension name", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/myext/models/greeter/model.ts",
    "/repo",
  );
  assertEquals(result, "myext");
});

Deno.test("extractExtensionNameFromPath: user-authored model (not in pulled-extensions)", () => {
  const result = extractExtensionNameFromPath(
    "/repo/extensions/models/greeter/model.ts",
    "/repo",
  );
  assertEquals(result, undefined);
});

Deno.test("extractExtensionNameFromPath: null repoDir", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/@testco/greeter/models/model.ts",
    null,
  );
  assertEquals(result, undefined);
});

Deno.test("extractExtensionNameFromPath: rejects path traversal in segments", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/../../../etc/models/model.ts",
    "/repo",
  );
  assertEquals(result, undefined);
});

Deno.test("extractExtensionNameFromPath: rejects null bytes in name", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/evil\0name/models/model.ts",
    "/repo",
  );
  assertEquals(result, undefined);
});

Deno.test("extractExtensionNameFromPath: path too short", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/only-one-segment",
    "/repo",
  );
  assertEquals(result, undefined);
});

Deno.test("extractExtensionNameFromPath: nested scoped path without a manifest still names an extension", () => {
  const result = extractExtensionNameFromPath(
    "/repo/.swamp/pulled-extensions/@swamp/aws/ec2/models/instance/model.ts",
    "/repo",
  );
  assertEquals(result, "@swamp/aws");
});

async function withTempRepo(
  fn: (repo: string) => Promise<void>,
): Promise<void> {
  const repo = await Deno.makeTempDir({ prefix: "swamp_extract_name_" });
  try {
    await fn(repo);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repo, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repo, { recursive: true });
    }
  }
}

async function installPackage(
  pulledRoot: string,
  name: string,
  sourceRelative: string,
): Promise<string> {
  const extensionRoot = join(pulledRoot, ...name.split("/"));
  const source = join(extensionRoot, ...sourceRelative.split("/"));
  await Deno.mkdir(join(source, ".."), { recursive: true });
  await Deno.writeTextFile(
    join(extensionRoot, "manifest.yaml"),
    `name: "${name}"\n`,
  );
  await Deno.writeTextFile(source, "export const model = {};\n");
  return source;
}

Deno.test("extractExtensionNameFromPath: a nested name resolves to the directory holding its manifest", async () => {
  await withTempRepo(async (repo) => {
    const pulledRoot = join(repo, ".swamp", "pulled-extensions");
    const gmail = await installPackage(
      pulledRoot,
      "@swamp/gcp/gmail",
      "models/users_messages.ts",
    );
    const ec2 = await installPackage(
      pulledRoot,
      "@swamp/aws/ec2",
      "models/instance/model.ts",
    );
    assertEquals(extractExtensionNameFromPath(gmail, repo), "@swamp/gcp/gmail");
    assertEquals(extractExtensionNameFromPath(ec2, repo), "@swamp/aws/ec2");
  });
});

Deno.test("extractExtensionNameFromPath: a nested name ending in a kind directory keeps that segment", async () => {
  await withTempRepo(async (repo) => {
    const source = await installPackage(
      join(repo, ".swamp", "pulled-extensions"),
      "@swamp/gcp/workflows",
      "models/workflow.ts",
    );
    assertEquals(
      extractExtensionNameFromPath(source, repo),
      "@swamp/gcp/workflows",
    );
  });
});

Deno.test("extractExtensionNameFromPath: a nested extension under its installed ancestor owns its files only when the lockfile says so", async () => {
  await withTempRepo(async (repo) => {
    const pulledRoot = join(repo, ".swamp", "pulled-extensions");
    const parent = await installPackage(
      pulledRoot,
      "@swamp/gcp",
      "models/shared.ts",
    );
    const nested = await installPackage(
      pulledRoot,
      "@swamp/gcp/gmail",
      "models/users_messages.ts",
    );
    const installed = new Set(["@swamp/gcp", "@swamp/gcp/gmail"]);
    const isInstalled = (name: string) => installed.has(name);
    assertEquals(
      extractExtensionNameFromPath(parent, repo, isInstalled),
      "@swamp/gcp",
    );
    assertEquals(
      extractExtensionNameFromPath(nested, repo, isInstalled),
      "@swamp/gcp/gmail",
    );
    assertEquals(extractExtensionNameFromPath(nested, repo), "@swamp/gcp");
  });
});

Deno.test("extractExtensionNameFromPath: resolves nested names under the managed config pulled root", async () => {
  await withTempRepo(async (repo) => {
    const source = await installPackage(
      join(repo, ".swamp", "config", "pulled-extensions"),
      "@swamp/gcp/gmail",
      "models/users_messages.ts",
    );
    assertEquals(
      extractExtensionNameFromPath(source, repo),
      "@swamp/gcp/gmail",
    );
  });
});

Deno.test("extractExtensionNameFromPath: an unscoped name with a manifest", async () => {
  await withTempRepo(async (repo) => {
    const source = await installPackage(
      join(repo, ".swamp", "pulled-extensions"),
      "myext",
      "models/greeter/model.ts",
    );
    assertEquals(extractExtensionNameFromPath(source, repo), "myext");
  });
});

Deno.test("extractExtensionNameFromPath: a manifest at the bare scope directory is not a name", async () => {
  await withTempRepo(async (repo) => {
    const pulledRoot = join(repo, ".swamp", "pulled-extensions");
    await Deno.mkdir(join(pulledRoot, "@swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(pulledRoot, "@swamp", "manifest.yaml"),
      'name: "@swamp"\n',
    );
    const source = join(pulledRoot, "@swamp", "ssh", "models", "ssh.ts");
    await Deno.mkdir(join(source, ".."), { recursive: true });
    await Deno.writeTextFile(source, "export const model = {};\n");
    assertEquals(extractExtensionNameFromPath(source, repo), "@swamp/ssh");
  });
});

Deno.test("extractExtensionNameFromPath: resolves through a symlinked repo directory", async () => {
  await withTempRepo(async (repo) => {
    const realRepo = join(repo, "real");
    const source = await installPackage(
      join(realRepo, ".swamp", "pulled-extensions"),
      "@swamp/gcp/gmail",
      "models/users_messages.ts",
    );
    const linkedRepo = join(repo, "linked");
    try {
      await Deno.symlink(realRepo, linkedRepo, { type: "dir" });
    } catch (error) {
      // Windows without symlink privilege cannot exercise this path.
      if (error instanceof Deno.errors.PermissionDenied) return;
      throw error;
    }
    assertEquals(
      extractExtensionNameFromPath(source, linkedRepo),
      "@swamp/gcp/gmail",
    );
  });
});

Deno.test("extractExtensionNameFromPath: a manifest.yaml naming another extension is package content, not an owner", async () => {
  await withTempRepo(async (repo) => {
    const pulledRoot = join(repo, ".swamp", "pulled-extensions");
    const source = await installPackage(
      pulledRoot,
      "@acme/tools",
      "models/templates/gen.ts",
    );
    await Deno.writeTextFile(
      join(
        pulledRoot,
        "@acme",
        "tools",
        "models",
        "templates",
        "manifest.yaml",
      ),
      'name: "@acme/fixture"\n',
    );
    assertEquals(extractExtensionNameFromPath(source, repo), "@acme/tools");
  });
});

Deno.test("extractExtensionNameFromPath: a directory named manifest.yaml is not an owner", async () => {
  await withTempRepo(async (repo) => {
    const pulledRoot = join(repo, ".swamp", "pulled-extensions");
    const source = await installPackage(
      pulledRoot,
      "@acme/tools",
      "models/templates/gen.ts",
    );
    await Deno.mkdir(
      join(
        pulledRoot,
        "@acme",
        "tools",
        "models",
        "templates",
        "manifest.yaml",
      ),
    );
    assertEquals(extractExtensionNameFromPath(source, repo), "@acme/tools");
  });
});

Deno.test("extractExtensionNameFromPath: a manifest naming its own subdirectory does not outrank the installed extension", async () => {
  await withTempRepo(async (repo) => {
    const pulledRoot = join(repo, ".swamp", "pulled-extensions");
    const source = await installPackage(
      pulledRoot,
      "@evil/tools",
      "models/sub/x.ts",
    );
    await Deno.writeTextFile(
      join(pulledRoot, "@evil", "tools", "models", "sub", "manifest.yaml"),
      'name: "@evil/tools/models/sub"\ndependencies:\n  - "@victim/vault-ops"\n',
    );
    const installed = new Set(["@evil/tools"]);
    assertEquals(
      extractExtensionNameFromPath(source, repo, (n) => installed.has(n)),
      "@evil/tools",
    );
  });
});

Deno.test("extractExtensionNameFromPath: the deepest installed name owns a source without reading any manifest", () => {
  const installed = new Set(["@swamp/gcp", "@swamp/gcp/gmail"]);
  const isInstalled = (name: string) => installed.has(name);
  assertEquals(
    extractExtensionNameFromPath(
      "/repo/.swamp/pulled-extensions/@swamp/gcp/gmail/models/users_messages.ts",
      "/repo",
      isInstalled,
    ),
    "@swamp/gcp/gmail",
  );
  assertEquals(
    extractExtensionNameFromPath(
      "/repo/.swamp/pulled-extensions/@swamp/gcp/models/shared.ts",
      "/repo",
      isInstalled,
    ),
    "@swamp/gcp",
  );
});

Deno.test("extractExtensionNameFromPath: a name the lockfile does not know yet falls back to its manifest", async () => {
  await withTempRepo(async (repo) => {
    const source = await installPackage(
      join(repo, ".swamp", "pulled-extensions"),
      "@swamp/gcp/gmail",
      "models/users_messages.ts",
    );
    assertEquals(
      extractExtensionNameFromPath(source, repo, () => false),
      "@swamp/gcp/gmail",
    );
  });
});

Deno.test("extractExtensionNameFromPath: without lockfile knowledge a manifest naming a package subdirectory still cannot take ownership", async () => {
  await withTempRepo(async (repo) => {
    const pulledRoot = join(repo, ".swamp", "pulled-extensions");
    const source = await installPackage(
      pulledRoot,
      "@evil/tools",
      "models/sub/x.ts",
    );
    await Deno.writeTextFile(
      join(pulledRoot, "@evil", "tools", "models", "sub", "manifest.yaml"),
      'name: "@evil/tools/models/sub"\n',
    );
    assertEquals(extractExtensionNameFromPath(source, repo), "@evil/tools");
    assertEquals(
      extractExtensionNameFromPath(source, repo, () => false),
      "@evil/tools",
    );
  });
});
