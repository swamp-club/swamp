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
import fc from "fast-check";
import {
  appDependencySpecifiers,
  PLATFORM_PACKAGES,
  shippedLockKeys,
} from "./app_dependencies.ts";

const SHA = "sha512-Aup7aUOfpbAUg2ROOJN6Iw5f9DMBlzu0mIkm/malLQFN==";

const nameArb = fc.constantFrom(
  "a",
  "b",
  "c",
  "d",
  "@s/e",
  "@s/f",
  "react",
  "d3-scale",
);
const runtimeFieldArb = fc.constantFrom(
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
);

interface LockModel {
  packages: Record<string, unknown>;
  manifest: Record<string, Record<string, string>>;
}

// keys nest at most two deep; every entry names its own package at 1.0.<n>
const lockArb: fc.Arbitrary<LockModel> = fc.record({
  keys: fc.uniqueArray(
    fc.array(nameArb, { minLength: 1, maxLength: 2 }).map((p) => p.join("/")),
    { maxLength: 12 },
  ),
  edges: fc.array(
    fc.tuple(fc.nat(), runtimeFieldArb, nameArb, fc.boolean()),
    { maxLength: 30 },
  ),
  runtime: fc.array(fc.tuple(runtimeFieldArb, nameArb), { maxLength: 4 }),
  dev: fc.array(nameArb, { maxLength: 6 }),
}).map(({ keys, edges, runtime, dev }) => {
  const meta: Record<string, Record<string, Record<string, string>>> = {};
  for (const key of keys) meta[key] = {};
  for (const [i, field, dep] of edges) {
    if (keys.length === 0) break;
    const key = keys[i % keys.length];
    (meta[key][field] ??= {})[dep] = "*";
  }
  const packages: Record<string, unknown> = {};
  keys.forEach((key, n) => {
    const name = keyNames(key).at(-1)!;
    packages[key] = [`${name}@1.0.${n}`, "", meta[key], SHA];
  });
  const manifest: Record<string, Record<string, string>> = {};
  for (const [field, name] of runtime) (manifest[field] ??= {})[name] = "*";
  for (const name of dev) (manifest.devDependencies ??= {})[name] = "*";
  return { packages, manifest };
});

function keyNames(key: string): string[] {
  const parts = key.split("/");
  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    names.push(
      parts[i].startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i],
    );
  }
  return names;
}

// node resolution from `key`: nested under it, then each ancestor, then the top
function resolveFrom(
  packages: Record<string, unknown>,
  key: string,
  dep: string,
): string | undefined {
  const names = keyNames(key);
  for (let depth = names.length; depth >= 0; depth--) {
    const candidate = [...names.slice(0, depth), dep].join("/");
    if (Object.hasOwn(packages, candidate)) return candidate;
  }
  return undefined;
}

function withoutDev(manifest: LockModel["manifest"]) {
  const { devDependencies: _dev, ...rest } = manifest;
  return rest;
}

Deno.test("shippedLockKeys: the closure is a subset of the lock and never a platform package", () => {
  fc.assert(
    fc.property(lockArb, ({ packages, manifest }) => {
      for (const key of shippedLockKeys(manifest, packages)) {
        assert(Object.hasOwn(packages, key));
        assert(!PLATFORM_PACKAGES.has(keyNames(key).at(-1)!));
      }
    }),
  );
});

Deno.test("shippedLockKeys: devDependencies never change what ships", () => {
  fc.assert(
    fc.property(lockArb, ({ packages, manifest }) => {
      assertEquals(
        shippedLockKeys(manifest, packages),
        shippedLockKeys(withoutDev(manifest), packages),
      );
    }),
  );
});

Deno.test("shippedLockKeys: the closure is closed under runtime dependencies", () => {
  fc.assert(
    fc.property(lockArb, ({ packages, manifest }) => {
      const shipped = shippedLockKeys(manifest, packages);
      for (const key of shipped) {
        const meta = (packages[key] as unknown[])[2] as Record<
          string,
          Record<string, string>
        >;
        for (const field of Object.values(meta)) {
          for (const dep of Object.keys(field)) {
            if (PLATFORM_PACKAGES.has(dep)) continue;
            const resolved = resolveFrom(packages, key, dep);
            if (resolved !== undefined) assert(shipped.has(resolved));
          }
        }
      }
    }),
  );
});

Deno.test("shippedLockKeys: every shipped package is reached from a runtime dependency", () => {
  fc.assert(
    fc.property(lockArb, ({ packages, manifest }) => {
      const shipped = shippedLockKeys(manifest, packages);
      const roots = Object.entries(withoutDev(manifest)).flatMap(([, deps]) =>
        Object.keys(deps)
      ).filter((name) => !PLATFORM_PACKAGES.has(name))
        .filter((name) => Object.hasOwn(packages, name));
      const reached = new Set<string>(roots);
      for (const key of shipped) {
        const meta = (packages[key] as unknown[])[2] as Record<
          string,
          Record<string, string>
        >;
        for (const field of Object.values(meta)) {
          for (const dep of Object.keys(field)) {
            if (PLATFORM_PACKAGES.has(dep)) continue;
            const resolved = resolveFrom(packages, key, dep);
            if (resolved !== undefined) reached.add(resolved);
          }
        }
      }
      for (const key of shipped) assert(reached.has(key));
    }),
  );
});

Deno.test("appDependencySpecifiers: every locked package is shipped or build-only, never both", () => {
  fc.assert(
    fc.property(lockArb, ({ packages, manifest }) => {
      const lock = JSON.stringify({
        lockfileVersion: 2,
        workspaces: { "": { name: "app" } },
        packages,
      });
      const deps = appDependencySpecifiers(
        {
          packageJson: JSON.stringify(manifest),
          bunLock: lock,
          otherLockfiles: [],
        },
        "app",
        "package.json",
        "bun.lock",
      );
      const id = (s: { name: string; bundled?: { version: string } }) =>
        `${s.name}@${s.bundled?.version}`;
      const shipped = new Set(deps.shipped.map(id));
      const buildOnly = new Set(deps.buildOnly.map(id));
      for (const s of shipped) assert(!buildOnly.has(s));
      const locked = new Set(
        Object.values(packages).map((e) => (e as string[])[0]),
      );
      assertEquals(new Set([...shipped, ...buildOnly]), locked);
    }),
  );
});
