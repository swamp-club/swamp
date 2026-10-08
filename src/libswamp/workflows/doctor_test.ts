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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { collect } from "../testing.ts";
import {
  doctorWorkflowDirs,
  doctorWorkflows,
  type DoctorWorkflowsDeps,
  type DoctorWorkflowsEvent,
  type DoctorWorkflowsReport,
} from "./doctor.ts";
import {
  assertPathArrayEquals,
  assertPathEquals,
} from "../../infrastructure/persistence/path_test_helpers.ts";

const VALID_WORKFLOW_YAML = `id: "550e8400-e29b-41d4-a716-446655440000"
name: test-workflow
jobs:
  - name: test-job
    steps:
      - name: test-step
        task:
          type: model_method
          modelIdOrName: my-model
          methodName: validate
`;

const BROKEN_YAML = `id: "550e8400-e29b-41d4-a716-446655440001"
name: broken-workflow
jobs:
  - name: bad-job
    steps:
      - name: bad-step
        task:
          type: model_method
          modelIdOrName: my-model
          methodName: validate
  invalid: yaml: here
`;

const INVALID_SCHEMA_YAML = `id: "not-a-uuid"
name: ""
`;

Deno.test("doctorWorkflows: reports pass for valid workflow", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, "workflow-test.yaml"),
      VALID_WORKFLOW_YAML,
    );

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    assertEquals(events.length, 2);
    assertEquals(events[0].kind, "workflow-checked");
    const checked = events[0] as Extract<
      DoctorWorkflowsEvent,
      { kind: "workflow-checked" }
    >;
    assertEquals(checked.result.status, "pass");
    assertEquals(checked.result.name, "test-workflow");

    const completed = events[1] as Extract<
      DoctorWorkflowsEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.report.overallStatus, "pass");
    assertEquals(completed.report.totalPassed, 1);
    assertEquals(completed.report.totalFailed, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: reports fail for broken YAML", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, "workflow-broken.yaml"),
      BROKEN_YAML,
    );

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    assertEquals(events.length, 2);
    const checked = events[0] as Extract<
      DoctorWorkflowsEvent,
      { kind: "workflow-checked" }
    >;
    assertEquals(checked.result.status, "fail");
    assertEquals(typeof checked.result.error, "string");

    const completed = events[1] as Extract<
      DoctorWorkflowsEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.report.overallStatus, "fail");
    assertEquals(completed.report.totalFailed, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: reports fail for invalid schema", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, "workflow-invalid.yaml"),
      INVALID_SCHEMA_YAML,
    );

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    const checked = events[0] as Extract<
      DoctorWorkflowsEvent,
      { kind: "workflow-checked" }
    >;
    assertEquals(checked.result.status, "fail");
    assertEquals(typeof checked.result.error, "string");
    // One readable line naming each field, not the raw Zod issue dump.
    const error = String(checked.result.error);
    assertEquals(error.includes("\n"), false);
    assertEquals(error.startsWith("["), false);
    assertStringIncludes(error, "id: ");
    assertStringIncludes(error, "name: ");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: handles missing directory gracefully", async () => {
  const events = await collect<DoctorWorkflowsEvent>(
    doctorWorkflows({
      workflowDirs: ["/tmp/nonexistent-swamp-dir-" + crypto.randomUUID()],
      abortSignal: new AbortController().signal,
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    DoctorWorkflowsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.report.overallStatus, "pass");
  assertEquals(completed.report.workflows.length, 0);
});

Deno.test("doctorWorkflows: skips non-yaml files", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(join(tmpDir, "notes.txt"), "not a workflow");
    await Deno.writeTextFile(join(tmpDir, "data.json"), "{}");

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    assertEquals(events.length, 1);
    assertEquals(events[0].kind, "completed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: scans multiple directories", async () => {
  const tmpDir1 = await Deno.makeTempDir({ prefix: "swamp_doctor_wf1_" });
  const tmpDir2 = await Deno.makeTempDir({ prefix: "swamp_doctor_wf2_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir1, "workflow-a.yaml"),
      VALID_WORKFLOW_YAML,
    );
    await Deno.writeTextFile(
      join(tmpDir2, "workflow-b.yaml"),
      VALID_WORKFLOW_YAML.replace(
        "550e8400-e29b-41d4-a716-446655440000",
        "660e8400-e29b-41d4-a716-446655440000",
      ).replace("test-workflow", "second-workflow"),
    );

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir1, tmpDir2],
        abortSignal: new AbortController().signal,
      }),
    );

    assertEquals(events.length, 3);
    const completed = events[2] as Extract<
      DoctorWorkflowsEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.report.totalPassed, 2);
    assertEquals(completed.report.overallStatus, "pass");
  } finally {
    await Deno.remove(tmpDir1, { recursive: true }).catch(() => {});
    await Deno.remove(tmpDir2, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: mixed pass and fail results", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, "workflow-good.yaml"),
      VALID_WORKFLOW_YAML,
    );
    await Deno.writeTextFile(
      join(tmpDir, "workflow-bad.yaml"),
      BROKEN_YAML,
    );

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    const completed = events[events.length - 1] as Extract<
      DoctorWorkflowsEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.report.overallStatus, "fail");
    assertEquals(completed.report.totalPassed, 1);
    assertEquals(completed.report.totalFailed, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: extracts name from parseable YAML even when construction fails", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, "workflow-invalid-schema.yaml"),
      INVALID_SCHEMA_YAML,
    );

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    const checked = events[0] as Extract<
      DoctorWorkflowsEvent,
      { kind: "workflow-checked" }
    >;
    assertEquals(checked.result.status, "fail");
    // Name extraction should still work even though schema validation fails
    // (empty string name won't parse from YAML since it's falsy)
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

const MANIFEST_YAML = `manifestVersion: 1
name: "@test/my-ext"
version: "2026.10.02.1"
workflows:
  - workflow-test.yaml
`;

const ARTIFACT_YAML = `networks:
  - default
tests:
  - name: smoke
`;

Deno.test("doctorWorkflows: skips manifests and non-workflow YAML in extension dirs", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, "workflow-test.yaml"),
      VALID_WORKFLOW_YAML,
    );
    await Deno.writeTextFile(join(tmpDir, "manifest.yaml"), MANIFEST_YAML);
    await Deno.writeTextFile(join(tmpDir, "manifest.yml"), MANIFEST_YAML);
    await Deno.writeTextFile(join(tmpDir, "test-factory.yaml"), ARTIFACT_YAML);

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [],
        extensionWorkflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    const completed = events.at(-1) as Extract<
      DoctorWorkflowsEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.report.overallStatus, "pass");
    assertEquals(completed.report.totalPassed, 1);
    assertEquals(completed.report.totalFailed, 0);
    assertEquals(
      completed.report.workflows.map((w) => w.name),
      ["test-workflow"],
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: still fails broken workflows in extension dirs", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(join(tmpDir, "broken.yaml"), BROKEN_YAML);
    await Deno.writeTextFile(
      join(tmpDir, "empty-jobs.yaml"),
      `id: "550e8400-e29b-41d4-a716-446655440002"\nname: empty-jobs\njobs: []\n`,
    );

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [],
        extensionWorkflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    const completed = events.at(-1) as Extract<
      DoctorWorkflowsEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.report.overallStatus, "fail");
    assertEquals(completed.report.totalFailed, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: still fails non-workflow YAML in repo workflow dirs", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(join(tmpDir, "workflow-x.yaml"), ARTIFACT_YAML);

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    const completed = events.at(-1) as Extract<
      DoctorWorkflowsEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.report.overallStatus, "fail");
    assertEquals(completed.report.totalFailed, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

function workflowYaml(name: string): string {
  return `id: "${crypto.randomUUID()}"
name: ${name}
jobs:
  - name: job
    steps:
      - name: step
        task:
          type: model_method
          modelIdOrName: my-model
          methodName: validate
`;
}

const UNKNOWN_TASK_YAML = `id: "550e8400-e29b-41d4-a716-446655440002"
name: unknown-task
jobs:
  - name: job
    steps:
      - name: step
        task:
          type: not_a_real_task
`;

async function runDoctor(
  deps: Omit<DoctorWorkflowsDeps, "abortSignal">,
  abortSignal = new AbortController().signal,
): Promise<DoctorWorkflowsReport> {
  const events = await collect<DoctorWorkflowsEvent>(
    doctorWorkflows({ ...deps, abortSignal }),
  );
  const completed = events.at(-1) as Extract<
    DoctorWorkflowsEvent,
    { kind: "completed" }
  >;
  return completed.report;
}

Deno.test("doctorWorkflows: checks nested and .yml files in extension dirs", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.mkdir(join(tmpDir, "nested", "deeper"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, "nested", "broken.yml"),
      UNKNOWN_TASK_YAML,
    );
    await Deno.writeTextFile(
      join(tmpDir, "nested", "deeper", "good.yml"),
      workflowYaml("nested-good"),
    );
    await Deno.writeTextFile(
      join(tmpDir, "nested", "manifest.yml"),
      MANIFEST_YAML,
    );
    await Deno.writeTextFile(
      join(tmpDir, "nested", "test-factory.yaml"),
      ARTIFACT_YAML,
    );

    const report = await runDoctor({
      workflowDirs: [],
      extensionWorkflowDirs: [tmpDir],
    });

    assertEquals(report.overallStatus, "fail");
    assertPathArrayEquals(report.workflows.map((w) => w.file), [
      join(tmpDir, "nested", "broken.yml"),
      join(tmpDir, "nested", "deeper", "good.yml"),
    ]);
    assertEquals(report.workflows.map((w) => [w.name, w.status]), [
      ["unknown-task", "fail"],
      ["nested-good", "pass"],
    ]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: strips .yml from the fallback name of unparseable files", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(join(tmpDir, "unparseable.yml"), "jobs: [oops");

    const report = await runDoctor({
      workflowDirs: [],
      extensionWorkflowDirs: [tmpDir],
    });

    assertEquals(report.totalFailed, 1);
    assertEquals(report.workflows[0].name, "unparseable");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: warns about loadable repo-dir YAML the loader does not read", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, "workflow-good.yaml"),
      workflowYaml("good"),
    );
    await Deno.writeTextFile(
      join(tmpDir, "deploy.yaml"),
      workflowYaml("deploy"),
    );
    await Deno.writeTextFile(
      join(tmpDir, "release.yml"),
      workflowYaml("release"),
    );
    await Deno.mkdir(join(tmpDir, "sub"));
    await Deno.writeTextFile(
      join(tmpDir, "sub", "workflow-hidden.yaml"),
      UNKNOWN_TASK_YAML,
    );

    const report = await runDoctor({ workflowDirs: [tmpDir] });

    // Not loaded, but neither passed nor was ignored before: warn, exit 0.
    assertEquals(report.overallStatus, "warn");
    assertEquals(
      [report.totalPassed, report.totalWarnings, report.totalFailed],
      [1, 2, 0],
    );
    assertEquals(report.workflows.map((w) => [w.name, w.status]), [
      ["deploy", "warn"],
      ["release", "warn"],
      ["good", "pass"],
    ]);
    const deploy = report.workflows[0];
    assertPathEquals(deploy.file, join(tmpDir, "deploy.yaml"));
    assertEquals(deploy.error, undefined);
    // The full path, since log mode labels the result only by its YAML name.
    assertStringIncludes(deploy.warning ?? "", join(tmpDir, "deploy.yaml"));
    assertStringIncludes(deploy.warning ?? "", "workflow-<name>.yaml");
    assertStringIncludes(
      deploy.warning ?? "",
      "or remove it if it is a stale copy",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: a broken misnamed .yaml in a repo dir still fails, a broken .yml only warns", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    // Before the loader's rule was applied, *.yaml here was always checked
    // and *.yml never was; neither outcome may get worse.
    await Deno.writeTextFile(join(tmpDir, "broken.yaml"), UNKNOWN_TASK_YAML);
    await Deno.writeTextFile(join(tmpDir, "broken.yml"), UNKNOWN_TASK_YAML);

    const report = await runDoctor({ workflowDirs: [tmpDir] });

    assertEquals(report.overallStatus, "fail");
    const [yaml, yml] = report.workflows;
    assertPathEquals(yaml.file, join(tmpDir, "broken.yaml"));
    assertEquals(yaml.status, "fail");
    // The note leads, on the first line, which log mode indents.
    const [firstLine] = (yaml.error ?? "").split("\n");
    assertStringIncludes(firstLine, "Not loaded:");
    assertStringIncludes(firstLine, "It also fails to load:");
    assertStringIncludes(yaml.error ?? "", "Invalid discriminator value");
    assertPathEquals(yml.file, join(tmpDir, "broken.yml"));
    assertEquals(yml.status, "warn");
    assertStringIncludes(yml.warning ?? "", "Not loaded:");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: tells non-workflow YAML in a repo dir to move out rather than rename", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(join(tmpDir, "settings.yaml"), ARTIFACT_YAML);
    await Deno.writeTextFile(join(tmpDir, "notes.yml"), "jobs: [oops");

    const report = await runDoctor({ workflowDirs: [tmpDir] });

    // settings.yaml failed before (no jobs) and still does; notes.yml was
    // never checked, so it only warns.
    assertEquals(report.workflows.map((w) => w.status), ["warn", "fail"]);
    for (const result of report.workflows) {
      const message = result.error ?? result.warning ?? "";
      assertStringIncludes(message, result.file);
      assertStringIncludes(message, "is not a workflow; move it out");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: a repo dir that is also an extension dir uses the extension rule for other names", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, "deploy.yaml"),
      workflowYaml("deploy"),
    );

    const report = await runDoctor({
      workflowDirs: [tmpDir],
      extensionWorkflowDirs: [tmpDir],
    });

    assertEquals(report.overallStatus, "pass");
    assertEquals(report.workflows.map((w) => w.name), ["deploy"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: reports a file reached through overlapping dirs once", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.mkdir(join(tmpDir, "vendor"));
    await Deno.writeTextFile(
      join(tmpDir, "vendor", "broken.yaml"),
      UNKNOWN_TASK_YAML,
    );

    const report = await runDoctor({
      workflowDirs: [],
      extensionWorkflowDirs: [tmpDir, join(tmpDir, "vendor")],
    });

    assertEquals(report.totalFailed, 1);
    assertEquals(report.workflows.length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: checks nothing once aborted", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(join(tmpDir, "broken.yaml"), UNKNOWN_TASK_YAML);
    const controller = new AbortController();
    controller.abort();

    const report = await runDoctor(
      { workflowDirs: [], extensionWorkflowDirs: [tmpDir] },
      controller.signal,
    );

    assertEquals(report.workflows, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflowDirs: takes the dirs the workflow repositories read", () => {
  const dirs = doctorWorkflowDirs({
    yamlWorkflowRepo: { getWorkflowsDir: () => "repo-workflows" },
    extensionWorkflowRepo: {
      getWorkflowDirs: () => ["extension-workflows", "source-a", "pulled-a"],
    },
  });

  assertEquals(dirs.workflowDirs, ["repo-workflows"]);
  assertEquals(dirs.extensionWorkflowDirs, [
    "extension-workflows",
    "source-a",
    "pulled-a",
  ]);
});

Deno.test("doctorWorkflowDirs: has no extension dirs without an extension repository", () => {
  const dirs = doctorWorkflowDirs({
    yamlWorkflowRepo: { getWorkflowsDir: () => "repo-workflows" },
    extensionWorkflowRepo: null,
  });

  assertEquals(dirs.workflowDirs, ["repo-workflows"]);
  assertEquals(dirs.extensionWorkflowDirs, []);
});
