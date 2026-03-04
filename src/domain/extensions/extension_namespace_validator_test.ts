// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import type { ExtensionContentMetadata } from "./extension_content.ts";
import { validateContentNamespaces } from "./extension_namespace_validator.ts";

function makeMetadata(
  overrides: Partial<ExtensionContentMetadata> = {},
): ExtensionContentMetadata {
  return {
    models: [],
    workflows: [],
    vaults: [],
    ...overrides,
  };
}

Deno.test("validateContentNamespaces — all content matches namespace — valid", () => {
  const result = validateContentNamespaces(
    "@stack72/my-extension",
    makeMetadata({
      models: [{
        fileName: "echo.ts",
        type: "@stack72/echo",
        version: "2026.03.01.1",
        globalArguments: [],
        methods: [],
        resources: [],
        files: [],
      }],
      vaults: [{
        fileName: "vault.ts",
        type: "@stack72/my-vault",
        name: "My Vault",
        description: "A vault",
        hasConfigSchema: false,
        configFields: [],
      }],
      workflows: [{
        fileName: "workflow.yaml",
        id: "wf-1",
        name: "@stack72/my-workflow",
        description: "A workflow",
        jobs: [],
      }],
    }),
  );
  assertEquals(result.valid, true);
  assertEquals(result.mismatches.length, 0);
});

Deno.test("validateContentNamespaces — model type with wrong namespace — mismatch", () => {
  const result = validateContentNamespaces(
    "@stack72/my-extension",
    makeMetadata({
      models: [{
        fileName: "echo.ts",
        type: "@evil/echo",
        version: "2026.03.01.1",
        globalArguments: [],
        methods: [],
        resources: [],
        files: [],
      }],
    }),
  );
  assertEquals(result.valid, false);
  assertEquals(result.mismatches.length, 1);
  assertEquals(result.mismatches[0].kind, "model");
  assertEquals(result.mismatches[0].identifier, "@evil/echo");
  assertEquals(result.mismatches[0].fileName, "echo.ts");
});

Deno.test("validateContentNamespaces — model type without @ prefix — mismatch", () => {
  const result = validateContentNamespaces(
    "@stack72/my-extension",
    makeMetadata({
      models: [{
        fileName: "instance.ts",
        type: "aws/ec2",
        version: "2026.03.01.1",
        globalArguments: [],
        methods: [],
        resources: [],
        files: [],
      }],
    }),
  );
  assertEquals(result.valid, false);
  assertEquals(result.mismatches.length, 1);
  assertEquals(result.mismatches[0].kind, "model");
  assertEquals(result.mismatches[0].identifier, "aws/ec2");
});

Deno.test("validateContentNamespaces — vault type with wrong namespace — mismatch", () => {
  const result = validateContentNamespaces(
    "@stack72/my-extension",
    makeMetadata({
      vaults: [{
        fileName: "vault.ts",
        type: "@other/vault",
        name: "Other Vault",
        description: "Wrong namespace",
        hasConfigSchema: false,
        configFields: [],
      }],
    }),
  );
  assertEquals(result.valid, false);
  assertEquals(result.mismatches.length, 1);
  assertEquals(result.mismatches[0].kind, "vault");
  assertEquals(result.mismatches[0].identifier, "@other/vault");
});

Deno.test("validateContentNamespaces — workflow name with wrong namespace — mismatch", () => {
  const result = validateContentNamespaces(
    "@stack72/my-extension",
    makeMetadata({
      workflows: [{
        fileName: "wf.yaml",
        id: "wf-1",
        name: "@swamp/reserved-workflow",
        description: "Wrong namespace",
        jobs: [],
      }],
    }),
  );
  assertEquals(result.valid, false);
  assertEquals(result.mismatches.length, 1);
  assertEquals(result.mismatches[0].kind, "workflow");
  assertEquals(result.mismatches[0].identifier, "@swamp/reserved-workflow");
});

Deno.test("validateContentNamespaces — workflow name without namespace prefix — mismatch", () => {
  const result = validateContentNamespaces(
    "@stack72/my-extension",
    makeMetadata({
      workflows: [{
        fileName: "plain.yaml",
        id: "wf-2",
        name: "plain-workflow",
        description: "No namespace",
        jobs: [],
      }],
    }),
  );
  assertEquals(result.valid, false);
  assertEquals(result.mismatches.length, 1);
  assertEquals(result.mismatches[0].kind, "workflow");
  assertEquals(result.mismatches[0].identifier, "plain-workflow");
});

Deno.test("validateContentNamespaces — mixed mismatches — all collected", () => {
  const result = validateContentNamespaces(
    "@stack72/my-extension",
    makeMetadata({
      models: [
        {
          fileName: "good.ts",
          type: "@stack72/good-model",
          version: "2026.03.01.1",
          globalArguments: [],
          methods: [],
          resources: [],
          files: [],
        },
        {
          fileName: "bad.ts",
          type: "@evil/bad-model",
          version: "2026.03.01.1",
          globalArguments: [],
          methods: [],
          resources: [],
          files: [],
        },
      ],
      vaults: [{
        fileName: "vault.ts",
        type: "@other/vault",
        name: "Other",
        description: "Wrong",
        hasConfigSchema: false,
        configFields: [],
      }],
      workflows: [{
        fileName: "wf.yaml",
        id: "wf-1",
        name: "no-namespace",
        description: "Missing namespace",
        jobs: [],
      }],
    }),
  );
  assertEquals(result.valid, false);
  assertEquals(result.mismatches.length, 3);
  assertEquals(result.mismatches[0].kind, "model");
  assertEquals(result.mismatches[1].kind, "vault");
  assertEquals(result.mismatches[2].kind, "workflow");
});

Deno.test("validateContentNamespaces — empty content — valid", () => {
  const result = validateContentNamespaces(
    "@stack72/my-extension",
    makeMetadata(),
  );
  assertEquals(result.valid, true);
  assertEquals(result.mismatches.length, 0);
});

Deno.test("validateContentNamespaces — partial mismatches — only wrong ones reported", () => {
  const result = validateContentNamespaces(
    "@stack72/my-extension",
    makeMetadata({
      models: [
        {
          fileName: "good.ts",
          type: "@stack72/good",
          version: "2026.03.01.1",
          globalArguments: [],
          methods: [],
          resources: [],
          files: [],
        },
        {
          fileName: "bad.ts",
          type: "@swamp/squatted",
          version: "2026.03.01.1",
          globalArguments: [],
          methods: [],
          resources: [],
          files: [],
        },
      ],
    }),
  );
  assertEquals(result.valid, false);
  assertEquals(result.mismatches.length, 1);
  assertEquals(result.mismatches[0].identifier, "@swamp/squatted");
  assertEquals(result.mismatches[0].fileName, "bad.ts");
});
