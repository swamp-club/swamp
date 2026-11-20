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

import { assert, assertEquals, assertMatch } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { walk } from "@std/fs";
import { parseAppDescriptor } from "../../domain/apps/app_descriptor.ts";
import { createLibSwampContext } from "../context.ts";
import { consumeStream } from "../stream.ts";
import { appInit, type AppInitInput, type AppTemplate } from "./init.ts";

async function run(input: AppInitInput): Promise<string | null> {
  let failure: string | null = null;
  await consumeStream(appInit(createLibSwampContext(), input), {
    completed: () => {},
    error: (e) => {
      failure = e.error.message;
    },
  });
  return failure;
}

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const parent = await Deno.makeTempDir();
  try {
    await body(join(parent, "app"));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(parent, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(parent, { recursive: true });
    }
  }
}

for (const template of ["dashboard", "gallery"] as AppTemplate[]) {
  Deno.test(`appInit: the ${template} template writes a valid app with its SDK`, async () => {
    await withDir(async (directory) => {
      const failure = await run({ name: "@acme/cost", directory, template });
      assertEquals(failure, null);
      const descriptor = parseAppDescriptor(
        await Deno.readTextFile(join(directory, "app.yaml")),
        "app.yaml",
      );
      assertEquals(descriptor.name, "@acme/cost");
      assertEquals(descriptor.title, "Cost");
      for (
        const file of [
          ".swamp-platform/app-sdk/connect.ts",
          ".swamp-platform/app-sdk/react.tsx",
          ".swamp-platform/app-sdk/vite.ts",
          ".swamp-platform/client/client.ts",
          "src/App.tsx",
          "mise.toml",
        ]
      ) {
        await Deno.stat(join(directory, file));
      }
      // the kit comes from swamp, so an app holds no copy of it
      const copied = await Deno.stat(join(directory, "src", "components"))
        .then(() => true, () => false);
      assertEquals(copied, false);
      assertMatch(
        await Deno.readTextFile(join(directory, ".gitignore")),
        /^\.swamp-platform$/m,
      );
    });
  });
}

Deno.test("appInit: app.yaml asks for the platform minor this swamp holds", async () => {
  await withDir(async (directory) => {
    let platform = "";
    await consumeStream(
      appInit(createLibSwampContext(), {
        name: "@acme/cost",
        directory,
        template: "gallery",
      }),
      {
        completed: (e) => {
          platform = e.data.platform;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );
    const manifest = await Deno.readTextFile(
      join(directory, ".swamp-platform", "platform.json"),
    ).then((text) => JSON.parse(text) as { minor: number }, () => undefined);
    assertEquals(platform, manifest ? `1.${manifest.minor}` : "1");
    if (manifest) {
      // unpacked from the build's authoring archive
      for (
        const file of [
          "ui/index.d.ts",
          "node_modules/clsx/package.json",
          "platform/1/dev/ui.js",
          "platform/1/dev/react.js",
        ]
      ) {
        await Deno.stat(join(directory, ".swamp-platform", file));
      }
    }
    const descriptor = parseAppDescriptor(
      await Deno.readTextFile(join(directory, "app.yaml")),
      "app.yaml",
    );
    assertEquals(String(descriptor.platform), platform);
  });
});

Deno.test("appInit: the scaffold pins Bun for mise", async () => {
  await withDir(async (directory) => {
    assertEquals(
      await run({ name: "@acme/cost", directory, template: "dashboard" }),
      null,
    );
    const mise = await Deno.readTextFile(join(directory, "mise.toml"));
    assertMatch(mise, /^bun = "\d+\.\d+\.\d+"$/m);
  });
});

Deno.test("appInit: every relative import in the copied SDK resolves", async () => {
  await withDir(async (directory) => {
    assertEquals(
      await run({ name: "@acme/cost", directory, template: "dashboard" }),
      null,
    );
    const missing: string[] = [];
    for await (
      const entry of walk(join(directory, ".swamp-platform"), {
        exts: [".ts", ".tsx"],
        // libraries' own declarations, resolved by their own conventions
        skip: [/[\\/]node_modules[\\/]/],
      })
    ) {
      const source = await Deno.readTextFile(entry.path);
      for (const match of source.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
        const target = join(dirname(entry.path), match[1]);
        // a declaration's import names the module, which resolves to its .d.ts
        const candidates = [target, `${target}.d.ts`];
        let found = false;
        for (const candidate of candidates) {
          if (await Deno.stat(candidate).then(() => true, () => false)) {
            found = true;
          }
        }
        if (!found) missing.push(`${entry.name} -> ${match[1]}`);
      }
    }
    assertEquals(missing, []);
  });
});

Deno.test("appInit: a title with quotes and markup stays valid", async () => {
  await withDir(async (directory) => {
    const title = 'The "Cost" <app>';
    assertEquals(
      await run({
        name: "@acme/cost",
        title,
        directory,
        template: "dashboard",
      }),
      null,
    );
    const descriptor = parseAppDescriptor(
      await Deno.readTextFile(join(directory, "app.yaml")),
      "app.yaml",
    );
    assertEquals(descriptor.title, title);
    const html = await Deno.readTextFile(join(directory, "index.html"));
    assert(html.includes("&lt;app&gt;"));
  });
});

Deno.test("appInit: refuses a folder that exists", async () => {
  await withDir(async (directory) => {
    await Deno.mkdir(directory);
    const failure = await run({
      name: "@acme/cost",
      directory,
      template: "dashboard",
    });
    assert(failure?.includes("already exists"));
  });
});

Deno.test("appInit: refuses a bad name or title before writing", async () => {
  await withDir(async (directory) => {
    assert(
      await run({ name: "cost", directory, template: "dashboard" }) !== null,
    );
    assert(
      await run({
        name: "@acme/cost",
        title: "",
        directory,
        template: "dashboard",
      }) !== null,
    );
    let wrote = true;
    await Deno.stat(directory).catch(() => {
      wrote = false;
    });
    assertEquals(wrote, false);
  });
});

Deno.test("app platform: no kit component reaches what the sandbox blocks", async () => {
  await withDir(async () => {
    const ui = fromFileUrl(
      new URL(
        "../../../packages/app-platform/1/ui/components/ui",
        import.meta.url,
      ),
    );
    for await (const entry of Deno.readDir(ui)) {
      if (!entry.name.endsWith(".tsx")) continue;
      const source = await Deno.readTextFile(join(ui, entry.name));
      for (
        const blocked of ["document.cookie", "localStorage", "next-themes"]
      ) {
        assert(
          !source.replace(/^\s*\/\/.*$/gm, "").includes(blocked),
          `${entry.name}: ${blocked}`,
        );
      }
    }
  });
});
