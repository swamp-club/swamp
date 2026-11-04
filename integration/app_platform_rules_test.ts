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

/** The app platform's compatibility promise, held statically: pins, exports, and what is served. */

import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import {
  APP_PLATFORM_PATH,
  authoringFolders,
} from "../src/domain/apps/app_platform.ts";
import { APP_PLATFORM_PREFIX } from "../packages/app-sdk/headers.ts";
import { PLATFORM_MODULES } from "../packages/app-sdk/vite.ts";
import { SDK_FILES } from "../src/libswamp/apps/platform_files.ts";
import {
  platformSurface,
  surfacePath,
} from "../scripts/app_platform_surface.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const PLATFORMS = join(ROOT, "packages", "app-platform");

function majors(): number[] {
  return [...Deno.readDirSync(PLATFORMS)]
    .filter((entry) => entry.isDirectory && /^[1-9][0-9]*$/.test(entry.name))
    .map((entry) => Number(entry.name));
}

function readJson<T>(...path: string[]): T {
  return JSON.parse(Deno.readTextFileSync(join(PLATFORMS, ...path))) as T;
}

interface Pins {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

Deno.test("app platform: every library is pinned exactly, and the lock agrees", () => {
  for (const major of majors()) {
    const pins = readJson<Pins>(String(major), "package.json");
    const lock = readJson<{
      packages: Record<string, { version?: string }>;
    }>(String(major), "package-lock.json");
    for (
      const [name, version] of Object.entries({
        ...pins.dependencies,
        ...pins.devDependencies,
      })
    ) {
      assertEquals(/^\d+\.\d+\.\d+$/.test(version), true, `${name} ${version}`);
      assertEquals(
        lock.packages[`node_modules/${name}`]?.version,
        version,
        `${name} in package-lock.json`,
      );
    }
  }
});

Deno.test("app platform: each promised library stays on its major", () => {
  for (const major of majors()) {
    const { promises } = readJson<{ promises: Record<string, number> }>(
      String(major),
      "platform.json",
    );
    const pins = readJson<Pins>(String(major), "package.json");
    for (const [name, promised] of Object.entries(promises)) {
      assertEquals(
        Number(pins.dependencies[name]?.split(".")[0]),
        promised,
        `platform ${major} promises ${name} ${promised}; a new major is a new platform`,
      );
    }
  }
});

Deno.test("app platform: an export is never removed, and a new one bumps the minor", () => {
  for (const major of majors()) {
    const snapshot = JSON.parse(Deno.readTextFileSync(surfacePath(major))) as {
      minor: number;
      exports: Record<string, string[]>;
    };
    const { minor } = readJson<{ minor: number }>(
      String(major),
      "platform.json",
    );
    const current = platformSurface(major);
    for (const [module, names] of Object.entries(snapshot.exports)) {
      const now = new Set(current[module] ?? []);
      assertEquals(
        names.filter((name) => !now.has(name)),
        [],
        `platform ${major} ${module}: removing an export needs a new major`,
      );
    }
    for (const [module, names] of Object.entries(current)) {
      const was = new Set(snapshot.exports[module] ?? []);
      assertEquals(
        names.filter((name) => !was.has(name)),
        [],
        `platform ${major} ${module}: new exports bump the minor in platform.json, then run deno task app-platform-surface ${major}`,
      );
    }
    assertEquals(snapshot.minor, minor, "surface.json is for another minor");
  }
});

Deno.test("app platform: the Vite plugin points only at modules the build serves", () => {
  for (const major of majors()) {
    const build = Deno.readTextFileSync(
      join(PLATFORMS, String(major), "build.mjs"),
    );
    for (const file of Object.values(PLATFORM_MODULES)) {
      const entry = file.replace(/\.js$/, "");
      assertEquals(
        build.includes(`"${entry}"`),
        true,
        `${file} is not built for platform ${major}`,
      );
    }
  }
});

Deno.test("app platform: every major's build is packed for authoring", () => {
  const tasks = (JSON.parse(Deno.readTextFileSync(join(ROOT, "deno.json"))) as {
    tasks: Record<string, string>;
  }).tasks;
  const task = tasks["build-app-platform"];
  for (const major of majors()) {
    assertEquals(
      task.includes(`scripts/pack_app_platform.ts ${major}`),
      true,
      `build-app-platform does not pack platform ${major}`,
    );
  }
});

Deno.test("app platform: the dev build unpacks where the Vite plugin serves it", () => {
  const vite = Deno.readTextFileSync(
    join(ROOT, "packages", "app-sdk", "vite.ts"),
  );
  assertEquals(
    /join\(\s*root,\s*"\.swamp-platform",\s*"platform",/.test(vite),
    true,
    "vite.ts no longer serves dev files from .swamp-platform/platform/",
  );
  assertEquals(vite.includes('${major}/${dev ? "dev/" : ""}'), true);
  for (const major of majors()) {
    assertEquals(authoringFolders(major).dev, `platform/${major}/dev`);
  }
});

Deno.test("app platform: the frame's policy and serve agree on its path", () => {
  assertEquals(APP_PLATFORM_PREFIX, `${APP_PLATFORM_PATH}/`);
});

Deno.test("app platform: an app's test copy of a served library is the version served", () => {
  const template = JSON.parse(
    Deno.readTextFileSync(
      join(ROOT, "packages", "app-sdk", "templates", "base", "package.json"),
    ),
  ) as Pins;
  const served = readJson<Pins>("1", "package.json").dependencies;
  for (const [name, version] of Object.entries(template.devDependencies)) {
    if (!(name in served)) continue;
    assertEquals(version, served[name], `${name} in the app template`);
  }
});

Deno.test("app platform: every SDK file an app's copy imports is copied", () => {
  const copied = new Set(
    Object.entries(SDK_FILES).flatMap(([dir, files]) =>
      files.map((file) => join(dir, file))
    ),
  );
  const missing: string[] = [];
  for (const file of copied) {
    if (!/\.tsx?$/.test(file)) continue;
    const source = Deno.readTextFileSync(join(ROOT, "packages", file));
    for (const [, spec] of source.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      const target = join(dirname(file), spec!);
      if (!copied.has(target)) missing.push(`${file} -> ${target}`);
    }
  }
  assertEquals(missing, []);
});
