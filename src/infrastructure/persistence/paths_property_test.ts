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

import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { isAbsolute, join, SEPARATOR } from "@std/path";
import fc from "fast-check";
import {
  bundleNamespace,
  SWAMP_DATA_DIR,
  swampPath,
  toAbsolutePath,
  toRelativePath,
} from "./paths.ts";
import { assertContainedPath, PathTraversalError } from "./safe_path.ts";
import { canonicalizePathFor } from "./canonicalize_path.ts";
import { assertPathEquals } from "./path_test_helpers.ts";

/**
 * Path components: ASCII, unicode, spaces, dots, dashes. Excluded from the
 * generator because they are outside the documented domain of a single
 * component: path separators ("/", "\") and NUL (never valid inside a
 * component), and ":" (drive-relative semantics on Windows would make the
 * string a different kind of path, not a component).
 */
const COMPONENT_CHARS = [
  ..."abcXYZ 0189._-".split(""),
  "\u00e9", // é
  "\u00df", // ß
  "\u03bb", // λ
  "\u65e5", // 日
  "\u{1f40a}", // 🐊 (surrogate pair)
];

const arbComponent = fc.stringOf(fc.constantFrom(...COMPONENT_CHARS), {
  minLength: 1,
  maxLength: 8,
});

/** Plain ASCII components for repo roots (and for domains where "." / ".."
 * normalization is out of scope). */
const arbAsciiName = fc.stringOf(
  fc.constantFrom(..."abcdefgh01".split("")),
  { minLength: 1, maxLength: 6 },
);

/** Absolute repo roots built from ASCII segments. Drive-less absolute paths
 * ("/a/b") are absolute on every platform @std/path supports. */
const arbRoot = fc
  .array(arbAsciiName, { minLength: 1, maxLength: 3 })
  .map((parts) => join("/", ...parts));

Deno.test("toRelativePath/toAbsolutePath: round-trip through the repo root", () => {
  fc.assert(
    fc.property(
      arbRoot,
      fc.array(arbComponent, { minLength: 1, maxLength: 4 }),
      (root, components) => {
        const abs = join(root, ...components);
        const rel = toRelativePath(root, abs);
        assert(!isAbsolute(rel), `expected relative, got ${rel}`);
        assertPathEquals(toAbsolutePath(root, rel), abs);
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("toRelativePath: passes already-relative paths through unchanged", () => {
  fc.assert(
    fc.property(
      arbRoot,
      fc.array(arbComponent, { minLength: 1, maxLength: 3 }),
      (root, components) => {
        const rel = components.join("/");
        assertEquals(toRelativePath(root, rel), rel);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("toAbsolutePath: passes already-absolute paths through unchanged", () => {
  fc.assert(
    fc.property(
      arbRoot,
      fc.array(arbComponent, { minLength: 1, maxLength: 3 }),
      (root, components) => {
        const abs = join(root, ...components);
        assertEquals(toAbsolutePath(root, abs), abs);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("swampPath: always composes root, .swamp, and the given segments", () => {
  fc.assert(
    fc.property(
      arbRoot,
      fc.array(arbComponent, { maxLength: 3 }),
      (root, segments) => {
        assertPathEquals(
          swampPath(root, ...segments),
          join(root, SWAMP_DATA_DIR, ...segments),
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("bundleNamespace: stable 8-hex-char hash, invariant under repo-root relocation", () => {
  fc.assert(
    fc.property(
      arbRoot,
      arbRoot,
      // ".." components are excluded: bundle source dirs live under the repo
      // root, and a dir that escapes a shallow root has a different relative
      // path than under a deep one — outside the documented domain.
      fc.array(arbComponent.filter((c) => c !== ".."), {
        minLength: 1,
        maxLength: 3,
      }),
      (rootA, rootB, components) => {
        const hash = bundleNamespace(join(rootA, ...components), rootA);
        assertMatch(hash, /^[0-9a-f]{8}$/);
        // Deterministic for the same inputs.
        assertEquals(bundleNamespace(join(rootA, ...components), rootA), hash);
        // The hash keys on the RELATIVE path, so relocating the repo root
        // (e.g. /var vs /private/var symlink resolution) keeps it stable.
        assertEquals(bundleNamespace(join(rootB, ...components), rootB), hash);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("assertContainedPath: accepts traversal-free relative components", () => {
  fc.assert(
    fc.property(
      arbRoot,
      fc
        .array(arbComponent.filter((c) => c !== ".."), {
          minLength: 1,
          maxLength: 4,
        })
        // At least one real segment — a chain of "." is the identity path,
        // which the guard rejects by design.
        .filter((cs) => cs.some((c) => c !== ".")),
      (boundary, components) => {
        assertContainedPath(components.join("/"), boundary);
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("assertContainedPath: rejects every escaping, absolute, or NUL-carrying input", () => {
  // Roots and escape targets draw from disjoint alphabets so climbing fully
  // out of the boundary can never land back on a boundary prefix.
  const arbEscapeName = fc.stringOf(
    fc.constantFrom(..."wxyz".split("")),
    { minLength: 1, maxLength: 6 },
  );
  fc.assert(
    fc.property(
      fc.array(arbAsciiName, { minLength: 1, maxLength: 3 }),
      arbEscapeName,
      fc.integer({ min: 0, max: 3 }),
      fc.constantFrom("upward", "absolute", "drive", "nul", "empty", "dot"),
      (rootParts, name, extraUps, kind) => {
        const boundary = join("/", ...rootParts);
        const rel = (() => {
          switch (kind) {
            case "upward":
              // Enough ".." to climb past the boundary (and any drive prefix
              // resolve() adds on Windows), then a disjoint-alphabet name.
              return [
                ...Array(rootParts.length + extraUps + 1).fill(".."),
                name,
              ].join("/");
            case "absolute":
              return `/${name}`;
            case "drive":
              return `C:\\${name}`;
            case "nul":
              return `${name}\0${name}`;
            case "empty":
              return "";
            default:
              return ".";
          }
        })();
        assertThrows(
          () => assertContainedPath(rel, boundary),
          PathTraversalError,
        );
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("assertContainedPath: never accepts a path that lexically escapes the boundary", () => {
  // Fuzz over arbitrary segment mixes (".." included): whenever the guard
  // accepts, joining under the boundary must stay under the boundary.
  fc.assert(
    fc.property(
      arbRoot,
      fc.array(
        fc.oneof(arbComponent, fc.constant(".."), fc.constant(".")),
        { minLength: 1, maxLength: 5 },
      ),
      (boundary, components) => {
        const rel = components.join("/");
        let accepted = true;
        try {
          assertContainedPath(rel, boundary);
        } catch (error) {
          assert(error instanceof PathTraversalError);
          accepted = false;
        }
        if (accepted) {
          const resolved = join(boundary, rel);
          assert(
            resolved === boundary ||
              resolved.startsWith(boundary + SEPARATOR),
            `accepted "${rel}" resolved outside boundary: ${resolved}`,
          );
        }
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("canonicalizePathFor: idempotent on both platforms for any string", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.string(), fc.unicodeString(), fc.fullUnicodeString()),
      fc.boolean(),
      (path, isWindows) => {
        const once = canonicalizePathFor(path, isWindows);
        assertEquals(canonicalizePathFor(once, isWindows), once);
        if (isWindows) {
          assert(!once.includes("\\"));
          assertEquals(once, once.toLowerCase());
        } else {
          // POSIX canonicalization is documented as the identity.
          assertEquals(once, path);
        }
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("canonicalizePathFor: maps every Windows surface form of a path to one key", () => {
  // ASCII-only components: unicode case pairs (e.g. ß/ẞ) are not stable
  // under upper→lower round-trips and are outside the NTFS-identity domain
  // this canonicalization was specified for.
  const arbAsciiComponent = fc.stringOf(
    fc.constantFrom(..."abcXYZ019._-".split("")),
    { minLength: 1, maxLength: 6 },
  );
  fc.assert(
    fc.property(
      fc.array(arbAsciiComponent, { minLength: 1, maxLength: 4 }),
      (components) => {
        const backslashed = `C:\\${components.join("\\")}`;
        const forward = `C:/${components.join("/")}`;
        const canonical = canonicalizePathFor(backslashed, true);
        assertEquals(canonicalizePathFor(forward, true), canonical);
        assertEquals(
          canonicalizePathFor(backslashed.toUpperCase(), true),
          canonical,
        );
        assertEquals(
          canonicalizePathFor(forward.toLowerCase(), true),
          canonical,
        );
      },
    ),
    { numRuns: 200 },
  );
});
