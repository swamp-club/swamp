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
import { freeRoots } from "../src/domain/expressions/cel_grammar.ts";
import {
  isForeignExpression,
  unresolvableVaultArguments,
} from "../src/domain/expressions/swamp_namespaces.ts";
import { extractVaultReferences } from "../src/domain/expressions/vault_reference_extractor.ts";
import { findVaultReferences } from "../src/domain/expressions/vault_reference_finder.ts";
import { DefaultWorkflowValidationService } from "../src/domain/workflows/validation_service.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";

Deno.test("vault call analysis: attribution, removal checks and workflow authorization agree on legacy references", async () => {
  const service = new DefaultWorkflowValidationService();
  for (
    const [source, key] of [
      ["vault.get(prod, KEY)", "KEY"],
      ["vault.get(`prod`, `Client ID`)", "Client ID"],
      [String.raw`vault.get('prod', 'a\nb')`, String.raw`a\nb`],
      ["vault.get(prod, 123)", "123"],
      ["vault.get(prod, my//key)", "my//key"],
      ["vault.get(prod, 'db.password')", "db.password"],
    ]
  ) {
    const text = "${{ " + source + " }}";
    // This is the unchanged public shape consumed by the dispatch allowlist.
    assertEquals(extractVaultReferences(text), {
      staticRefs: [{ vaultName: "prod", secretKey: key }],
      hasDynamicRefs: false,
    }, source);
    assertEquals(freeRoots(source), new Set(["vault"]), source);
    assertEquals(isForeignExpression(source), false, source);
    assertEquals(unresolvableVaultArguments(source), [], source);
    assertEquals(
      findVaultReferences("prod", {
        definitions: [],
        workflows: [],
        datastoreConfig: { token: text },
      }).references.length,
      1,
      source,
    );
    for (const listed of [true, false]) {
      const workflow = Workflow.create({
        name: "vault-compatibility",
        vaults: listed ? ["prod"] : [],
        jobs: [Job.create({
          name: "main",
          steps: [Step.create({
            name: "run",
            task: StepTask.model("reader", "run", { token: text }),
          })],
        })],
      });
      const results = await service.validate(workflow);
      assertEquals(
        results.find((r) =>
          r.name === "Vaults the workflow reads are in its vaults list"
        )?.passed,
        listed,
        source,
      );
    }
  }
});

Deno.test("vault call analysis: compatibility shim does not grant new remote authorization", () => {
  for (
    const source of [
      "vault . get (prod, KEY)",
      "vault.get(prod, inputs.key + '-suffix')",
      "self.vault.get('prod', 'KEY')",
      "literal('vault.get(prod, KEY)')",
    ]
  ) {
    assertEquals(extractVaultReferences("${{ " + source + " }}"), {
      staticRefs: [],
      hasDynamicRefs: false,
    }, source);
  }
  assertEquals(extractVaultReferences("${{ vault.get(inputs.v, inputs.k) }}"), {
    staticRefs: [],
    hasDynamicRefs: true,
  });
  assertEquals(unresolvableVaultArguments("vault.get(prod, db..key)"), [
    "db..key",
  ]);
  // The option-off resolver replaces this call even though vault is bound.
  assertEquals(
    extractVaultReferences("${{ [1].map(vault, vault.get(prod, KEY)) }}"),
    {
      staticRefs: [{ vaultName: "prod", secretKey: "KEY" }],
      hasDynamicRefs: false,
    },
  );
});

Deno.test("vault call analysis: multi-argument CEL cannot change a legacy match's reference identity", () => {
  for (
    const [source, vaultName, secretKey] of [
      ["vault.get(prod, 'a', 'b')", "prod", "a', 'b"],
      ["vault.get('a', 'b', k)", "a', 'b", "k"],
    ]
  ) {
    const text = "${{ " + source + " }}";
    assertEquals(extractVaultReferences(text), {
      staticRefs: [{ vaultName, secretKey }],
      hasDynamicRefs: false,
    });
    assertEquals(
      findVaultReferences(vaultName, {
        definitions: [],
        workflows: [],
        datastoreConfig: text,
      }).references.length,
      1,
    );
  }
});
