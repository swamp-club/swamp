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
import archive from "./archive_layout.json" with { type: "json" };
import secretDocs from "./secret_docs.json" with { type: "json" };
import spdx from "./spdx.json" with { type: "json" };
import {
  denoDocJsonArgs,
  denoDocLintArgs,
  EntrypointEscapesRootError,
  entrypointPaths,
  findManifestRoot,
  LICENSE_FILENAMES,
  presentInOrder,
  README_FILENAMES,
} from "../archive/layout.ts";
import {
  type ArchiveFile,
  detectSecretDocs,
  markdownImports,
  type SecretDocsAcceptance,
  secretDocsAcceptanceMatcher,
  type SecretDocsForm,
  secretDocsTargets,
} from "../secret_docs/mod.ts";
import { isValidManifestLicense } from "../licensing/mod.ts";
import { licenseAllowed } from "../dependency_audit/mod.ts";

for (const v of archive.entrypoints) {
  Deno.test(`archive vectors: entrypoints, ${v.name}`, () => {
    let actual: unknown;
    try {
      actual = entrypointPaths(v.manifest as Record<string, unknown>);
    } catch (error) {
      if (!(error instanceof EntrypointEscapesRootError)) throw error;
      actual = { escapes: error.entry };
    }
    assertEquals(actual, v.expect);
  });
}

for (const v of archive.docFiles) {
  Deno.test(`archive vectors: doc files, ${v.name}`, () => {
    assertEquals(
      presentInOrder(
        v.kind === "readme" ? README_FILENAMES : LICENSE_FILENAMES,
        v.listing,
      ),
      v.expect,
    );
  });
}

for (const v of archive.manifestRoots) {
  Deno.test(`archive vectors: manifest root, ${v.name}`, async () => {
    const dirs = new Set<string>();
    for (const file of v.files) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    }
    const root = await findManifestRoot({
      hasManifest: (dir) =>
        Promise.resolve(
          v.files.includes(
            dir === "" ? "manifest.yaml" : `${dir}/manifest.yaml`,
          ),
        ),
      subdirectories: (dir) =>
        Promise.resolve(
          [...dirs]
            .filter((d) => {
              const rest = dir === "" ? d : d.slice(dir.length + 1);
              return (dir === "" || d.startsWith(`${dir}/`)) &&
                !rest.includes("/");
            })
            .map((d) => d.split("/").pop()!),
        ),
    });
    assertEquals(root, v.expect);
  });
}

Deno.test("archive vectors: deno doc arguments", () => {
  assertEquals(denoDocJsonArgs(["models/a.ts"]), archive.denoDoc.json);
  assertEquals(denoDocLintArgs(["models/a.ts"]), archive.denoDoc.lint);
});

for (const v of secretDocs.detection) {
  Deno.test(`secret-docs vectors: detects ${v.name}`, () => {
    const schemas = "schemas" in v && v.schemas
      ? {
        declared: new Set(v.schemas.declared),
        sensitive: new Set(v.schemas.sensitive),
      }
      : undefined;
    assertEquals(
      detectSecretDocs(v.text, v.form as SecretDocsForm, schemas).map((f) =>
        f.line
      ),
      v.expectLines,
    );
  });
}

for (const v of secretDocs.selection) {
  Deno.test(`secret-docs vectors: selects ${v.name}`, () => {
    assertEquals(
      secretDocsTargets(
        v.files as ArchiveFile[],
        v.manifest,
        new Set(v.importedMarkdown),
      ),
      v.expect,
    );
  });
}

for (const v of secretDocs.markdownImports) {
  Deno.test(`secret-docs vectors: markdown imports, ${v.name}`, () => {
    assertEquals(markdownImports(v.path, v.source), v.expect);
  });
}

for (const v of secretDocs.acceptance) {
  Deno.test(`secret-docs vectors: acceptance, ${v.name}`, () => {
    const accepted = secretDocsAcceptanceMatcher(
      v.acceptances as SecretDocsAcceptance[],
    );
    assertEquals(
      (v.findings as { file?: string; line: number }[]).map((f) =>
        accepted({ ...f, message: "" })
      ),
      v.expectAccepted,
    );
  });
}

for (const v of spdx.manifest) {
  Deno.test(`spdx vectors: manifest license ${JSON.stringify(v.license)}`, () => {
    assertEquals(isValidManifestLicense(v.license), v.valid);
  });
}

for (const v of spdx.dependency) {
  Deno.test(`spdx vectors: dependency license ${JSON.stringify(v.license)}`, () => {
    assertEquals(licenseAllowed(v.license), v.allowed);
  });
}
