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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { APP_SOURCE_DIR } from "../../domain/apps/app_descriptor.ts";
import {
  APP_DEV_DIR,
  APP_DEV_HEARTBEAT_MS,
  FilesystemAppCatalog,
  hasAppDescriptors,
  writeDevRegistration,
} from "./filesystem_app_catalog.ts";

const descriptor = (name: string) =>
  `name: "${name}"\ntitle: T\nbridge: 1\ncapabilities: [runs:read]\n`;

async function withRepo(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function addApp(
  root: string,
  folder: string,
  name: string,
  appsDir = "apps",
) {
  await Deno.mkdir(join(root, appsDir, folder, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(root, appsDir, folder, "app.yaml"),
    descriptor(name),
  );
}

function addLocalApp(root: string, folder: string, name: string) {
  return addApp(root, folder, name, APP_SOURCE_DIR);
}

Deno.test("FilesystemAppCatalog: finds a repo's own apps and whether they are built", async () => {
  await withRepo(async (repoDir) => {
    await addLocalApp(repoDir, "cost", "@acme/cost");
    const before = await new FilesystemAppCatalog({ repoDir }).list();
    assertEquals(before.apps[0].origin, "local");
    assertEquals(before.apps[0].built, false);
    await Deno.writeTextFile(
      join(repoDir, APP_SOURCE_DIR, "cost", "dist", "index.html"),
      "<html>",
    );
    const after = await new FilesystemAppCatalog({ repoDir }).list();
    assertEquals(after.apps[0].built, true);
  });
});

Deno.test("FilesystemAppCatalog: finds an app in a pulled extension", async () => {
  await withRepo(async (repoDir) => {
    const root = join(repoDir, ".swamp", "pulled-extensions", "@acme", "ext");
    await addApp(root, "cost", "@acme/cost");
    await Deno.writeTextFile(
      join(root, "manifest.yaml"),
      'manifestVersion: 1\nname: "@acme/ext"\nversion: "2026.11.04.1"\napps: [apps/cost]\n',
    );
    const { apps } = await new FilesystemAppCatalog({ repoDir }).list();
    assertEquals(apps[0].origin, "extension");
    assertEquals(apps[0].version, "2026.11.04.1");
  });
});

Deno.test("FilesystemAppCatalog: a pulled app cannot borrow another collective's name", async () => {
  await withRepo(async (repoDir) => {
    const root = join(repoDir, ".swamp", "pulled-extensions", "@evil", "ext");
    await addApp(root, "cost", "@acme/cost");
    await Deno.writeTextFile(
      join(root, "manifest.yaml"),
      'manifestVersion: 1\nname: "@evil/ext"\nversion: "2026.11.04.1"\napps: [apps/cost]\n',
    );
    const { apps, problems } = await new FilesystemAppCatalog({ repoDir })
      .list();
    assertEquals(apps, []);
    assertEquals(problems.length, 1);
  });
});

Deno.test("FilesystemAppCatalog: a repo's folder wins over a pulled copy", async () => {
  await withRepo(async (repoDir) => {
    await addLocalApp(repoDir, "cost", "@acme/cost");
    const pulled = join(repoDir, ".swamp", "pulled-extensions", "@acme", "ext");
    await addApp(pulled, "cost", "@acme/cost");
    await Deno.writeTextFile(
      join(pulled, "manifest.yaml"),
      'manifestVersion: 1\nname: "@acme/ext"\nversion: "2026.11.04.1"\napps: [apps/cost]\n',
    );
    const { apps } = await new FilesystemAppCatalog({ repoDir }).list();
    assertEquals(apps.length, 1);
    assertEquals(apps[0].origin, "local");
  });
});

Deno.test("FilesystemAppCatalog: a bad descriptor never hides the others", async () => {
  await withRepo(async (repoDir) => {
    await addLocalApp(repoDir, "good", "@acme/good");
    await Deno.mkdir(join(repoDir, APP_SOURCE_DIR, "bad"));
    await Deno.writeTextFile(
      join(repoDir, APP_SOURCE_DIR, "bad", "app.yaml"),
      "x: [",
    );
    const { apps, problems } = await new FilesystemAppCatalog({ repoDir })
      .list();
    assertEquals(apps.length, 1);
    assertEquals(problems.length, 1);
  });
});

Deno.test("FilesystemAppCatalog: follows a dev server only when told to", async () => {
  await withRepo(async (repoDir) => {
    await addLocalApp(repoDir, "cost", "@acme/cost");
    await writeDevRegistration(repoDir, {
      name: "@acme/cost",
      root: join(repoDir, APP_SOURCE_DIR, "cost"),
      url: "http://127.0.0.1:5173/",
    });
    const serve = await new FilesystemAppCatalog({ repoDir }).list();
    assertEquals(serve.apps[0].devUrl, undefined);
    const local = await new FilesystemAppCatalog({
      repoDir,
      followDevServers: true,
    }).list();
    assertEquals(local.apps[0].devUrl, "http://127.0.0.1:5173/");
  });
});

Deno.test("FilesystemAppCatalog: ignores a dev server that is not on loopback", async () => {
  await withRepo(async (repoDir) => {
    await addLocalApp(repoDir, "cost", "@acme/cost");
    await writeDevRegistration(repoDir, {
      name: "@acme/cost",
      root: repoDir,
      url: "http://evil.example/",
    });
    const { apps } = await new FilesystemAppCatalog({
      repoDir,
      followDevServers: true,
    }).list();
    assert(apps[0].devUrl === undefined);
  });
});

Deno.test("FilesystemAppCatalog: a dev registration that is not an object is ignored", async () => {
  await withRepo(async (repoDir) => {
    await addLocalApp(repoDir, "cost", "@acme/cost");
    const dir = join(repoDir, ".swamp", APP_DEV_DIR);
    await Deno.mkdir(dir, { recursive: true });
    for (const [file, text] of [["a.json", "null"], ["b.json", "7"]]) {
      await Deno.writeTextFile(join(dir, file), text);
    }
    const { apps } = await new FilesystemAppCatalog({
      repoDir,
      followDevServers: true,
    }).list();
    assertEquals(apps.map((app) => app.devUrl), [undefined]);
  });
});

Deno.test("FilesystemAppCatalog: a files/ tree cannot pass for an extension", async () => {
  await withRepo(async (repoDir) => {
    const extension = join(
      repoDir,
      ".swamp",
      "pulled-extensions",
      "@evil",
      "x",
    );
    await Deno.mkdir(extension, { recursive: true });
    await Deno.writeTextFile(
      join(extension, "manifest.yaml"),
      'manifestVersion: 1\nname: "@evil/x"\nversion: "1"\napps: []\n',
    );
    const shipped = join(extension, "files");
    await addApp(shipped, "cost", "@acme/cost");
    await Deno.writeTextFile(
      join(shipped, "manifest.yaml"),
      'manifestVersion: 1\nname: "@acme/fake"\nversion: "1"\napps: [apps/cost]\n',
    );
    const { apps, problems } = await new FilesystemAppCatalog({ repoDir })
      .list();
    assertEquals(apps, []);
    assertEquals(problems.length, 1);
  });
});

Deno.test("FilesystemAppCatalog: a pulled app its manifest does not list is refused", async () => {
  await withRepo(async (repoDir) => {
    const root = join(repoDir, ".swamp", "pulled-extensions", "@acme", "ext");
    await addApp(root, "cost", "@acme/cost");
    await Deno.writeTextFile(
      join(root, "manifest.yaml"),
      'manifestVersion: 1\nname: "@acme/ext"\nversion: "1"\napps: []\n',
    );
    const { apps } = await new FilesystemAppCatalog({ repoDir }).list();
    assertEquals(apps, []);
  });
});

Deno.test("FilesystemAppCatalog: a mounted source does not replace the repo's own app", async () => {
  await withRepo(async (repoDir) => {
    await addLocalApp(repoDir, "cost", "@acme/cost");
    const source = join(repoDir, "mounted");
    await addLocalApp(source, "cost", "@acme/cost");
    const { apps } = await new FilesystemAppCatalog({
      repoDir,
      sourceDirs: () => Promise.resolve([source]),
    }).list();
    assertEquals(apps[0].origin, "local");
  });
});

Deno.test("FilesystemAppCatalog: a dev server that stopped its heartbeat is ignored", async () => {
  await withRepo(async (repoDir) => {
    await addLocalApp(repoDir, "cost", "@acme/cost");
    const path = await writeDevRegistration(repoDir, {
      name: "@acme/cost",
      root: join(repoDir, APP_SOURCE_DIR, "cost"),
      url: "http://127.0.0.1:5173/",
    });
    const old = new Date(Date.now() - 10 * APP_DEV_HEARTBEAT_MS);
    await Deno.utime(path, old, old);
    const { apps } = await new FilesystemAppCatalog({
      repoDir,
      followDevServers: true,
    }).list();
    assertEquals(apps[0].devUrl, undefined);
  });
});

Deno.test("FilesystemAppCatalog: a dev server must be the app's own folder", async () => {
  await withRepo(async (repoDir) => {
    await addLocalApp(repoDir, "cost", "@acme/cost");
    await writeDevRegistration(repoDir, {
      name: "@acme/cost",
      root: join(repoDir, "elsewhere"),
      url: "http://127.0.0.1:5173/",
    });
    const { apps } = await new FilesystemAppCatalog({
      repoDir,
      followDevServers: true,
    }).list();
    assertEquals(apps[0].devUrl, undefined);
  });
});

Deno.test("FilesystemAppCatalog: a dev server never stands in for a pulled app", async () => {
  await withRepo(async (repoDir) => {
    const root = join(repoDir, ".swamp", "pulled-extensions", "@acme", "ext");
    await addApp(root, "cost", "@acme/cost");
    await Deno.writeTextFile(
      join(root, "manifest.yaml"),
      'manifestVersion: 1\nname: "@acme/ext"\nversion: "1"\napps: [apps/cost]\n',
    );
    await writeDevRegistration(repoDir, {
      name: "@acme/cost",
      root: join(root, "apps", "cost"),
      url: "http://127.0.0.1:5173/",
    });
    const { apps } = await new FilesystemAppCatalog({
      repoDir,
      followDevServers: true,
    }).list();
    assertEquals(apps[0].devUrl, undefined);
  });
});

Deno.test("FilesystemAppCatalog: a manifest name cannot climb out of its install path", async () => {
  await withRepo(async (repoDir) => {
    const extension = join(
      repoDir,
      ".swamp",
      "pulled-extensions",
      "@evil",
      "x",
    );
    const shipped = join(extension, "files");
    await addApp(shipped, "cost", "@acme/cost");
    await Deno.writeTextFile(
      join(shipped, "manifest.yaml"),
      'manifestVersion: 1\nname: "@acme/../@evil/x/files"\nversion: "1"\napps: [apps/cost]\n',
    );
    const { apps, problems } = await new FilesystemAppCatalog({ repoDir })
      .list();
    assertEquals(apps, []);
    assertEquals(problems.length, 1);
  });
});

Deno.test("FilesystemAppCatalog: a collective is matched whole", async () => {
  await withRepo(async (repoDir) => {
    const root = join(
      repoDir,
      ".swamp",
      "pulled-extensions",
      "@acme-evil",
      "x",
    );
    await addApp(root, "cost", "@acme/cost");
    await Deno.writeTextFile(
      join(root, "manifest.yaml"),
      'manifestVersion: 1\nname: "@acme-evil/x"\nversion: "1"\napps: [apps/cost]\n',
    );
    const { apps } = await new FilesystemAppCatalog({ repoDir }).list();
    assertEquals(apps, []);
  });
});

Deno.test("hasAppDescriptors: true only when a folder under extensions/apps holds an app.yaml", async () => {
  await withRepo(async (dir) => {
    assertEquals(await hasAppDescriptors(join(dir, "missing")), false);
    assertEquals(await hasAppDescriptors(dir), false);
    await Deno.mkdir(join(dir, APP_SOURCE_DIR, "empty"), { recursive: true });
    assertEquals(await hasAppDescriptors(dir), false);
    await addLocalApp(dir, "hello", "@acme/hello");
    assertEquals(await hasAppDescriptors(dir), true);
  });
});

Deno.test("hasAppDescriptors: a file where a source folder is expected has no apps", async () => {
  await withRepo(async (dir) => {
    const file = join(dir, "not-a-dir");
    await Deno.writeTextFile(file, "");
    assertEquals(await hasAppDescriptors(file), false);
  });
});

// chmod cannot deny a read to root, and Windows has no mode bits
const cannotDenyRead = Deno.build.os === "windows" || Deno.uid() === 0;

async function whileUnreadable<T>(
  dir: string,
  body: () => Promise<T>,
): Promise<T> {
  await Deno.chmod(dir, 0o000);
  try {
    return await body();
  } finally {
    await Deno.chmod(dir, 0o755);
  }
}

async function addPulledApp(
  repoDir: string,
  extension: string,
  folder: string,
  name: string,
): Promise<string> {
  const root = join(repoDir, ".swamp", "pulled-extensions", "@acme", extension);
  await addApp(root, folder, name);
  await Deno.writeTextFile(
    join(root, "manifest.yaml"),
    `manifestVersion: 1\nname: "@acme/${extension}"\nversion: "1"\napps: [apps/${folder}]\n`,
  );
  return root;
}

const names = (apps: readonly { descriptor: { name: string } }[]) =>
  apps.map((app) => app.descriptor.name);

Deno.test({
  name:
    "FilesystemAppCatalog: an unreadable source apps folder is a problem, not a crash",
  ignore: cannotDenyRead,
  fn: async () => {
    await withRepo(async (repoDir) => {
      await addLocalApp(repoDir, "cost", "@acme/cost");
      const source = join(repoDir, "mounted");
      await addLocalApp(source, "other", "@acme/other");
      const appsDir = join(source, APP_SOURCE_DIR);
      const { apps, problems } = await whileUnreadable(
        appsDir,
        () =>
          new FilesystemAppCatalog({
            repoDir,
            sourceDirs: () => Promise.resolve([source]),
          }).list(),
      );
      assertEquals(names(apps), ["@acme/cost"]);
      assertEquals(problems.map((problem) => problem.path), [appsDir]);
    });
  },
});

Deno.test({
  name:
    "FilesystemAppCatalog: an unreadable repo apps folder still lists a source's apps",
  ignore: cannotDenyRead,
  fn: async () => {
    await withRepo(async (repoDir) => {
      await addLocalApp(repoDir, "cost", "@acme/cost");
      const source = join(repoDir, "mounted");
      await addLocalApp(source, "other", "@acme/other");
      const appsDir = join(repoDir, APP_SOURCE_DIR);
      const { apps, problems } = await whileUnreadable(
        appsDir,
        () =>
          new FilesystemAppCatalog({
            repoDir,
            sourceDirs: () => Promise.resolve([source]),
          }).list(),
      );
      assertEquals(names(apps), ["@acme/other"]);
      assertEquals(problems.map((problem) => problem.path), [appsDir]);
    });
  },
});

Deno.test({
  name:
    "FilesystemAppCatalog: an app folder it cannot search is a problem, not a missing app",
  ignore: cannotDenyRead,
  fn: async () => {
    await withRepo(async (repoDir) => {
      await addLocalApp(repoDir, "cost", "@acme/cost");
      const source = join(repoDir, "mounted");
      await addLocalApp(source, "locked", "@acme/locked");
      const appDir = join(source, APP_SOURCE_DIR, "locked");
      await whileUnreadable(appDir, async () => {
        const { apps, problems } = await new FilesystemAppCatalog({
          repoDir,
          sourceDirs: () => Promise.resolve([source]),
        }).list();
        assertEquals(names(apps), ["@acme/cost"]);
        assertEquals(problems.map((problem) => problem.path), [
          join(appDir, "app.yaml"),
        ]);
        assertEquals(await hasAppDescriptors(source), false);
      });
    });
  },
});

Deno.test({
  name:
    "FilesystemAppCatalog: an unreadable pulled extension never hides another's apps",
  ignore: cannotDenyRead,
  fn: async () => {
    await withRepo(async (repoDir) => {
      const broken = await addPulledApp(repoDir, "a", "cost", "@acme/cost");
      await addPulledApp(repoDir, "b", "other", "@acme/other");
      const appsDir = join(broken, "apps");
      const { apps, problems } = await whileUnreadable(
        appsDir,
        () => new FilesystemAppCatalog({ repoDir }).list(),
      );
      assertEquals(names(apps), ["@acme/other"]);
      assertEquals(problems.map((problem) => problem.path), [appsDir]);
    });
  },
});

Deno.test({
  name:
    "FilesystemAppCatalog: a source that is a file is a problem, not a crash",
  // Windows reports a path through a file as not found
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async (repoDir) => {
      await addLocalApp(repoDir, "cost", "@acme/cost");
      const file = join(repoDir, "not-a-dir");
      await Deno.writeTextFile(file, "");
      const { apps, problems } = await new FilesystemAppCatalog({
        repoDir,
        sourceDirs: () => Promise.resolve([file]),
      }).list();
      assertEquals(names(apps), ["@acme/cost"]);
      assertEquals(problems.map((problem) => problem.path), [
        join(file, APP_SOURCE_DIR),
      ]);
    });
  },
});

Deno.test("FilesystemAppCatalog: a pulled app.yaml link is found, a linked folder is not entered", async () => {
  await withRepo(async (repoDir) => {
    const root = join(repoDir, ".swamp", "pulled-extensions", "@acme", "ext");
    await Deno.mkdir(join(root, "apps", "cost"), { recursive: true });
    const real = join(repoDir, "real");
    await addApp(real, "cost", "@acme/cost");
    await addApp(real, "linked", "@acme/linked");
    await Deno.symlink(
      join(real, "apps", "cost", "app.yaml"),
      join(root, "apps", "cost", "app.yaml"),
      { type: "file" },
    );
    await Deno.symlink(
      join(real, "apps", "linked"),
      join(root, "apps", "linked"),
      { type: "dir" },
    );
    await Deno.writeTextFile(
      join(root, "manifest.yaml"),
      'manifestVersion: 1\nname: "@acme/ext"\nversion: "1"\napps: [apps/cost, apps/linked]\n',
    );
    const { apps, problems } = await new FilesystemAppCatalog({ repoDir })
      .list();
    assertEquals(names(apps), ["@acme/cost"]);
    assertEquals(problems, []);
  });
});
