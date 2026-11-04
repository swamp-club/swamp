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
  appBundleFiles,
  duplicateAppFolder,
  readAppBundle,
} from "./extension_app_bundle.ts";

async function withApp(
  body: (dir: string) => Promise<void>,
  descriptor = `name: "@acme/cost"\ntitle: Cost\nbridge: 1\n`,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "dist"));
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "app.yaml"), descriptor);
    await Deno.writeTextFile(join(dir, "dist", "index.html"), "<html>");
    await Deno.writeTextFile(join(dir, "src", "secret.ts"), "source");
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("readAppBundle: ships the descriptor and the build, not the source", async () => {
  await withApp(async (dir) => {
    const bundle = await readAppBundle(dir, "@acme/ext");
    assertEquals(
      [...bundle.archivePaths].sort(),
      ["app.yaml", join("dist", "index.html")].sort(),
    );
  });
});

Deno.test("readAppBundle: ships package.json and bun.lock for the registry's audit", async () => {
  await withApp(async (dir) => {
    await Deno.writeTextFile(join(dir, "package.json"), "{}");
    await Deno.writeTextFile(join(dir, "bun.lock"), "{}");
    await Deno.mkdir(join(dir, "node_modules"));
    const bundle = await readAppBundle(dir, "@acme/ext");
    assertEquals(
      [...bundle.archivePaths].sort(),
      ["app.yaml", "bun.lock", join("dist", "index.html"), "package.json"]
        .sort(),
    );
  });
});

Deno.test("readAppBundle: refuses another collective's name", async () => {
  await withApp(async (dir) => {
    await assertRejects(
      () => readAppBundle(dir, "@other/ext"),
      UserError,
      "@other",
    );
  });
});

Deno.test("readAppBundle: refuses an unbuilt app", async () => {
  await withApp(async (dir) => {
    await Deno.remove(join(dir, "dist", "index.html"));
    await assertRejects(
      () => readAppBundle(dir, "@acme/ext"),
      UserError,
      "swamp app build",
    );
  });
});

Deno.test("readAppBundle: refuses a file swamp would not serve", async () => {
  await withApp(async (dir) => {
    await Deno.writeTextFile(join(dir, "dist", "run.sh"), "#!/bin/sh");
    await assertRejects(
      () => readAppBundle(dir, "@acme/ext"),
      UserError,
      "run.sh",
    );
  });
});

Deno.test("readAppBundle: refuses a file inside a dot folder of the build", async () => {
  await withApp(async (dir) => {
    await Deno.mkdir(join(dir, "dist", ".cache"));
    await Deno.writeTextFile(join(dir, "dist", ".cache", "creds.json"), "{}");
    await assertRejects(
      () => readAppBundle(dir, "@acme/ext"),
      UserError,
      "creds.json",
    );
  });
});

Deno.test("readAppBundle: refuses a build folder that is a symlink", async () => {
  await withApp(async (dir) => {
    const outside = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(outside, "index.html"), "<html>");
      await Deno.writeTextFile(join(outside, "secret.json"), "{}");
      await Deno.remove(join(dir, "dist"), { recursive: true });
      await Deno.symlink(outside, join(dir, "dist"), { type: "dir" });
      await assertRejects(
        () => readAppBundle(dir, "@acme/ext"),
        UserError,
        "not a symlink",
      );
    } finally {
      await Deno.remove(outside, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("readAppBundle: refuses a build folder reached through a symlink outside the app", async () => {
  await withApp(async (dir) => {
    const outside = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(outside, "dist"));
      await Deno.writeTextFile(join(outside, "dist", "index.html"), "<html>");
      await Deno.symlink(outside, join(dir, "out"), { type: "dir" });
      await Deno.writeTextFile(
        join(dir, "app.yaml"),
        `name: "@acme/cost"\ntitle: Cost\nbridge: 1\nentry: out/dist/index.html\n`,
      );
      await assertRejects(
        () => readAppBundle(dir, "@acme/ext"),
        UserError,
        "inside the app",
      );
    } finally {
      await Deno.remove(outside, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("readAppBundle: refuses a symlink in the build", async () => {
  await withApp(async (dir) => {
    await Deno.symlink(
      join(dir, "src", "secret.ts"),
      join(dir, "dist", "link.js"),
      { type: "file" },
    );
    await assertRejects(
      () => readAppBundle(dir, "@acme/ext"),
      UserError,
      "symlink",
    );
  });
});

Deno.test("appBundleFiles: a broken app adds nothing, for push's gate to report", async () => {
  await withApp(async (dir) => {
    assertEquals(
      await appBundleFiles({ name: "@other/ext", apps: ["."] }, dir),
      [],
    );
  });
});

Deno.test("duplicateAppFolder: names a clash the archive would lose", () => {
  assertEquals(duplicateAppFolder(["a/cost", "b/cost"]), "cost");
  assertEquals(duplicateAppFolder(["a/cost", "b/other"]), null);
});
