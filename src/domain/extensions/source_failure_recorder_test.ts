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
import {
  extensionKindToKindDir,
  findSourceByPath,
  kindDirToExtensionKind,
  recordSourceFailure,
} from "./source_failure_recorder.ts";
import { makeExtension } from "./extension.ts";
import { makeSourceLocation } from "./source_location.ts";
import { makeSource } from "./source.ts";
import { makeBundleLocation } from "./bundle_location.ts";
import { ValidationError } from "./validation_error.ts";

const REPO_ROOT = "/repo";

function makeTestExtension(
  sources: Parameters<typeof makeExtension>[0]["sources"] = [],
) {
  return makeExtension({
    name: "@local/test",
    version: "0.0.0",
    origin: "local",
    extensionRoot: REPO_ROOT,
    sources,
  });
}

function makeTestLocation(path: string) {
  return makeSourceLocation(path, REPO_ROOT);
}

// ---- recordSourceFailure: ValidationError input ----

Deno.test("recordSourceFailure: ValidationError returns ValidationFailed state with bundle location", () => {
  const loc = makeTestLocation("/repo/extensions/models/foo.ts");
  const ext = makeTestExtension([
    makeSource({
      id: loc,
      kind: "model",
      fingerprint: "fp1",
      state: {
        tag: "Indexed",
        type: "my-model",
        bundle: makeBundleLocation("/repo/.swamp/bundles/foo.js", "fp1"),
      },
      sourceMtime: "2026-01-01T00:00:00.000Z",
    }),
  ]);

  const error = new ValidationError(
    "bad schema",
    "/repo/.swamp/bundles/foo.js",
    "fp2",
  );
  const existingSource = findSourceByPath(ext, loc.canonicalPath);

  const result = recordSourceFailure({
    extension: ext,
    location: loc,
    kindDir: "models",
    error,
    existingSource,
    fingerprint: "fp2",
    sourceMtime: "2026-01-02T00:00:00.000Z",
  });

  const source = findSourceByPath(result.extension, loc.canonicalPath);
  assertEquals(source?.state.tag, "ValidationFailed");
});

// ---- recordSourceFailure: non-ValidationError input ----

Deno.test("recordSourceFailure: non-ValidationError returns BundleBuildFailed state", () => {
  const loc = makeTestLocation("/repo/extensions/models/foo.ts");
  const ext = makeTestExtension([
    makeSource({
      id: loc,
      kind: "model",
      fingerprint: "fp1",
      state: {
        tag: "Indexed",
        type: "my-model",
        bundle: makeBundleLocation("/repo/.swamp/bundles/foo.js", "fp1"),
      },
      sourceMtime: "2026-01-01T00:00:00.000Z",
    }),
  ]);

  const error = new Error("bundle build exploded");
  const existingSource = findSourceByPath(ext, loc.canonicalPath);

  const result = recordSourceFailure({
    extension: ext,
    location: loc,
    kindDir: "models",
    error,
    existingSource,
    fingerprint: "fp2",
    sourceMtime: "2026-01-02T00:00:00.000Z",
  });

  const source = findSourceByPath(result.extension, loc.canonicalPath);
  assertEquals(source?.state.tag, "BundleBuildFailed");
});

// ---- existing source uses recordValidationFailed / recordBundleBuildFailed ----

Deno.test("recordSourceFailure: existing source with ValidationError uses recordValidationFailed", () => {
  const loc = makeTestLocation("/repo/extensions/models/foo.ts");
  const bundle = makeBundleLocation("/repo/.swamp/bundles/foo.js", "fp1");
  const ext = makeTestExtension([
    makeSource({
      id: loc,
      kind: "model",
      fingerprint: "fp1",
      state: { tag: "Indexed", type: "my-model", bundle },
      sourceMtime: "2026-01-01T00:00:00.000Z",
    }),
  ]);

  const error = new ValidationError(
    "invalid",
    "/repo/.swamp/bundles/foo.js",
    "fp2",
  );
  const existingSource = findSourceByPath(ext, loc.canonicalPath);
  assertEquals(existingSource !== undefined, true);

  const result = recordSourceFailure({
    extension: ext,
    location: loc,
    kindDir: "models",
    error,
    existingSource,
    fingerprint: "fp2",
    sourceMtime: "2026-01-02T00:00:00.000Z",
  });

  const updated = findSourceByPath(result.extension, loc.canonicalPath);
  assertEquals(updated?.state.tag, "ValidationFailed");
  assertEquals(updated?.fingerprint, "fp2");
});

Deno.test("recordSourceFailure: existing source with generic error uses recordBundleBuildFailed", () => {
  const loc = makeTestLocation("/repo/extensions/models/foo.ts");
  const bundle = makeBundleLocation("/repo/.swamp/bundles/foo.js", "fp1");
  const ext = makeTestExtension([
    makeSource({
      id: loc,
      kind: "model",
      fingerprint: "fp1",
      state: { tag: "Indexed", type: "my-model", bundle },
      sourceMtime: "2026-01-01T00:00:00.000Z",
    }),
  ]);

  const error = new Error("compile error");
  const existingSource = findSourceByPath(ext, loc.canonicalPath);

  const result = recordSourceFailure({
    extension: ext,
    location: loc,
    kindDir: "models",
    error,
    existingSource,
    fingerprint: "fp2",
    sourceMtime: "2026-01-02T00:00:00.000Z",
  });

  const updated = findSourceByPath(result.extension, loc.canonicalPath);
  assertEquals(updated?.state.tag, "BundleBuildFailed");
});

// ---- new source (existingSource undefined) uses makeExtensionWithNewSource ----

Deno.test("recordSourceFailure: new source with ValidationError creates new source via makeExtensionWithNewSource", () => {
  const loc = makeTestLocation("/repo/extensions/models/bar.ts");
  const ext = makeTestExtension();

  const error = new ValidationError(
    "bad",
    "/repo/.swamp/bundles/bar.js",
    "fp1",
  );

  const result = recordSourceFailure({
    extension: ext,
    location: loc,
    kindDir: "models",
    error,
    existingSource: undefined,
    fingerprint: "fp1",
    sourceMtime: "2026-01-01T00:00:00.000Z",
  });

  const source = findSourceByPath(result.extension, loc.canonicalPath);
  assertEquals(source !== undefined, true);
  assertEquals(source?.state.tag, "ValidationFailed");
  assertEquals(source?.kind, "model");
});

Deno.test("recordSourceFailure: new source with generic error creates new source via makeExtensionWithNewSource", () => {
  const loc = makeTestLocation("/repo/extensions/models/bar.ts");
  const ext = makeTestExtension();

  const error = new Error("boom");

  const result = recordSourceFailure({
    extension: ext,
    location: loc,
    kindDir: "models",
    error,
    existingSource: undefined,
    fingerprint: "fp1",
    sourceMtime: "2026-01-01T00:00:00.000Z",
  });

  const source = findSourceByPath(result.extension, loc.canonicalPath);
  assertEquals(source !== undefined, true);
  assertEquals(source?.state.tag, "BundleBuildFailed");
  assertEquals(source?.kind, "model");
});

// ---- transition emitted when fromState !== toState ----

Deno.test("recordSourceFailure: emits transition when fromState differs from toState", () => {
  const loc = makeTestLocation("/repo/extensions/models/foo.ts");
  const bundle = makeBundleLocation("/repo/.swamp/bundles/foo.js", "fp1");
  const ext = makeTestExtension([
    makeSource({
      id: loc,
      kind: "model",
      fingerprint: "fp1",
      state: { tag: "Indexed", type: "my-model", bundle },
      sourceMtime: "2026-01-01T00:00:00.000Z",
    }),
  ]);

  const error = new Error("build failed");
  const existingSource = findSourceByPath(ext, loc.canonicalPath);

  const result = recordSourceFailure({
    extension: ext,
    location: loc,
    kindDir: "models",
    error,
    existingSource,
    fingerprint: "fp2",
    sourceMtime: "2026-01-02T00:00:00.000Z",
  });

  assertEquals(result.transition !== undefined, true);
  assertEquals(result.transition?.fromState, "Indexed");
  assertEquals(result.transition?.toState, "BundleBuildFailed");
});

// ---- no transition when fromState === toState ----

Deno.test("recordSourceFailure: no transition when fromState equals toState", () => {
  const loc = makeTestLocation("/repo/extensions/models/foo.ts");
  const ext = makeTestExtension([
    makeSource({
      id: loc,
      kind: "model",
      fingerprint: "fp1",
      state: { tag: "BundleBuildFailed", lastError: "old error" },
      sourceMtime: "2026-01-01T00:00:00.000Z",
    }),
  ]);

  const error = new Error("still failing");
  const existingSource = findSourceByPath(ext, loc.canonicalPath);

  const result = recordSourceFailure({
    extension: ext,
    location: loc,
    kindDir: "models",
    error,
    existingSource,
    fingerprint: "fp2",
    sourceMtime: "2026-01-02T00:00:00.000Z",
  });

  assertEquals(result.transition, undefined);
});

// ---- no transition for new source (fromState is null, toState is non-null) ----

Deno.test("recordSourceFailure: emits transition for new source (fromState null)", () => {
  const loc = makeTestLocation("/repo/extensions/models/new.ts");
  const ext = makeTestExtension();

  const error = new Error("fail");

  const result = recordSourceFailure({
    extension: ext,
    location: loc,
    kindDir: "models",
    error,
    existingSource: undefined,
    fingerprint: "fp1",
    sourceMtime: "2026-01-01T00:00:00.000Z",
  });

  // fromState is null (new source), toState is BundleBuildFailed — they differ
  assertEquals(result.transition !== undefined, true);
  assertEquals(result.transition?.fromState, null);
  assertEquals(result.transition?.toState, "BundleBuildFailed");
});

// ---- kindDirToExtensionKind mappings ----

Deno.test("kindDirToExtensionKind: maps all kindDir values correctly", () => {
  assertEquals(kindDirToExtensionKind("models"), "model");
  assertEquals(kindDirToExtensionKind("vaults"), "vault");
  assertEquals(kindDirToExtensionKind("drivers"), "driver");
  assertEquals(kindDirToExtensionKind("datastores"), "datastore");
  assertEquals(kindDirToExtensionKind("reports"), "report");
});

// ---- extensionKindToKindDir mappings ----

Deno.test("extensionKindToKindDir: maps all extensionKind values correctly", () => {
  assertEquals(extensionKindToKindDir("model"), "models");
  assertEquals(extensionKindToKindDir("extension"), "models");
  assertEquals(extensionKindToKindDir("vault"), "vaults");
  assertEquals(extensionKindToKindDir("driver"), "drivers");
  assertEquals(extensionKindToKindDir("datastore"), "datastores");
  assertEquals(extensionKindToKindDir("report"), "reports");
});

// ---- findSourceByPath ----

Deno.test("findSourceByPath: returns source when path matches", () => {
  const loc = makeTestLocation("/repo/extensions/models/foo.ts");
  const ext = makeTestExtension([
    makeSource({
      id: loc,
      kind: "model",
      fingerprint: "fp1",
      state: { tag: "BundleBuildFailed", lastError: "err" },
      sourceMtime: "2026-01-01T00:00:00.000Z",
    }),
  ]);

  const found = findSourceByPath(ext, loc.canonicalPath);
  assertEquals(found !== undefined, true);
  assertEquals(found?.kind, "model");
});

Deno.test("findSourceByPath: returns undefined when path does not match", () => {
  const ext = makeTestExtension();
  const found = findSourceByPath(ext, "/repo/extensions/models/nonexistent.ts");
  assertEquals(found, undefined);
});
