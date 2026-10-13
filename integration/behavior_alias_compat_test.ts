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

// Goldens for the behavior spelling of stored formats (swamp-club#3334).
// Captured on the code before the spelling was accepted: every model-spelled
// workflow must normalise byte-identically, and `swamp workflow schema` may
// only grow by the behavior step-task variants.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  fixtureNames,
  normalisedWorkflow,
  readFixture,
  respellAsBehavior,
  SCHEMA_GOLDEN_PATH,
  withoutBehaviorVariants,
  WORKFLOW_GOLDEN_PATH,
  workflowSchemaData,
  writtenWorkflow,
} from "./test_helpers/behavior_alias/golden_corpus.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import {
  createWorkflowEditDeps,
  workflowEdit,
  type WorkflowEditEvent,
} from "../src/libswamp/workflows/edit.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  parseAuditConfig,
  readServeConfigFile,
  writeServeConfigFile,
} from "../src/serve/serve_config.ts";
import {
  type AuditLevel,
  AuditPolicy,
  type AuditPolicyRule,
} from "../src/domain/serve_audit/audit_policy.ts";
import { AlertRuleEngine } from "../src/domain/serve_audit/audit_alerts.ts";
import { createAuditEvent } from "../src/domain/serve_audit/audit_event.ts";

async function readGolden(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>;
}

Deno.test("behavior alias goldens: model-spelled workflows normalise byte-identically", async () => {
  const golden = await readGolden(WORKFLOW_GOLDEN_PATH);
  const names = await fixtureNames();
  assertEquals(names, Object.keys(golden).sort());
  assert(names.length >= 30, `corpus too small: ${names.length}`);
  for (const name of names) {
    // JSON text, not deep equality: key order is what a written file keeps.
    assertEquals(
      JSON.stringify(normalisedWorkflow(await readFixture(name))),
      JSON.stringify(golden[name]),
      name,
    );
  }
});

Deno.test("behavior alias goldens: workflow schema only grows by behavior variants", async () => {
  const golden = await readGolden(SCHEMA_GOLDEN_PATH);
  const current = await workflowSchemaData();
  assertEquals(
    JSON.stringify(withoutBehaviorVariants(current)),
    JSON.stringify(golden),
  );
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-behavior-alias-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("behavior alias goldens: the behavior-spelled corpus normalises to the model goldens", async () => {
  const golden = await readGolden(WORKFLOW_GOLDEN_PATH);
  let respelledTotal = 0;
  for (const name of await fixtureNames()) {
    const model = await readFixture(name);
    const { yaml, respelled } = respellAsBehavior(model);
    respelledTotal += respelled;
    assertEquals(
      JSON.stringify(normalisedWorkflow(yaml)),
      JSON.stringify(golden[name]),
      name,
    );
    assertEquals(writtenWorkflow(yaml), writtenWorkflow(model), name);
  }
  assert(respelledTotal >= 40, `too few tasks respelled: ${respelledTotal}`);
});

Deno.test("behavior alias: workflow edit writes a behavior-spelled file back in the model form", async () => {
  await withTempDir(async (repoDir) => {
    const repo = new YamlWorkflowRepository(repoDir);
    const fixture = await readFixture("200-all-step-types.yaml");
    const stored = Workflow.fromData(parseYaml(fixture) as never);
    await repo.save(stored);
    const path = repo.getPath(stored.id);
    const modelFile = await Deno.readTextFile(path);

    const { yaml } = respellAsBehavior(fixture);
    assertStringIncludes(yaml, "type: behavior");
    const events = await collect<WorkflowEditEvent>(
      workflowEdit(
        createLibSwampContext(),
        createWorkflowEditDeps(repoDir, repo),
        { workflowIdOrName: stored.id, byId: true, stdinContent: yaml },
      ),
    );
    assertEquals(events.at(-1)?.kind, "completed");
    const written = await Deno.readTextFile(repo.getPath(stored.id));
    // Older binaries read what swamp writes: the model form, byte for byte.
    assertEquals(written, modelFile);
    assert(!written.includes("behavior"), written);
  });
});

Deno.test("behavior alias: audit rules match in the model spelling without touching the serve config file", async () => {
  await withTempDir(async (repoDir) => {
    const configPath = join(repoDir, "serve.yaml");
    const content = `audit:
  stores:
    - type: local
      path: .swamp/audit
  policy:
    default-level: metadata
    rules:
      - action: behavior.method.run
        level: requestResponse
  alerts:
    - name: runs
      match:
        action: behavior.method.run
      threshold:
        count: 1
        window-seconds: 60
      action:
        type: log
`;
    await Deno.writeTextFile(configPath, content);
    const config = await readServeConfigFile(repoDir, configPath);
    const audit = parseAuditConfig(config);
    assert(audit);
    // Built as serve builds them.
    const policy = new AuditPolicy(
      audit.policyRules.map((r) => ({
        category: undefined,
        action: r.action,
        tier: r.tier as AuditPolicyRule["tier"],
        level: r.level as AuditLevel,
      })),
      audit.policyDefaultLevel as AuditLevel,
    );
    const engine = new AlertRuleEngine(audit.alerts.map((a) => ({
      name: a.name,
      match: { action: a.match.action },
      threshold: {
        count: a.threshold.count,
        windowSeconds: a.threshold["window-seconds"],
      },
      action: { type: "log" as const },
    })));
    assertEquals(
      policy.evaluate("execution", "model.method.run"),
      "requestResponse",
    );
    const fired = engine.evaluate(createAuditEvent({
      instanceId: "i",
      category: "execution",
      stage: "response",
      outcome: "success",
      action: "model.method.run",
      resourceKind: "model",
      resourceName: "m",
      principalKind: "user",
      principalId: "u",
      initiatedBy: "user:u",
      sourceIp: "127.0.0.1",
      requestId: crypto.randomUUID(),
    }));
    assertEquals(fired.length, 1);
    // The file is untouched, and a later write of the loaded config (as
    // workflow trigger set does) keeps the spelling the user wrote.
    assertEquals(await Deno.readTextFile(configPath), content);
    await writeServeConfigFile(repoDir, config!, configPath);
    const rewritten = await Deno.readTextFile(configPath);
    assertEquals(
      (rewritten.match(/behavior\.method\.run/g) ?? []).length,
      2,
      rewritten,
    );
    assert(!rewritten.includes("model.method.run"), rewritten);
  });
});

Deno.test("behavior alias: workflow schema has the behavior variant beside model_method", async () => {
  const current = await workflowSchemaData();
  const text = JSON.stringify(current.stepTask);
  assertStringIncludes(text, '"const":"behavior"');
  assertStringIncludes(text, '"behaviorType"');
});
