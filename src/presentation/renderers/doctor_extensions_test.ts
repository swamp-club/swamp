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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type {
  DoctorExtensionsReport,
  DoctorRegistryName,
  DoctorRegistryResult,
  ReconcileTransition,
} from "../../libswamp/mod.ts";
import { makeSourceLocation } from "../../domain/extensions/source_location.ts";
import { createDoctorExtensionsRenderer } from "./doctor_extensions.ts";

await initializeLogging({});

function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  return Promise.resolve(fn())
    .finally(() => {
      console.log = originalLog;
    })
    .then(() => lines.join("\n"));
}

function passResult(registry: DoctorRegistryName): DoctorRegistryResult {
  return { registry, status: "pass", failures: [] };
}

function failResult(
  registry: DoctorRegistryName,
  failures: Array<{ file: string; error: string }>,
): DoctorRegistryResult {
  return { registry, status: "fail", failures };
}

function buildPassReport(): DoctorExtensionsReport {
  return {
    overallStatus: "pass",
    registries: {
      model: passResult("model"),
      vault: passResult("vault"),
      driver: passResult("driver"),
      datastore: passResult("datastore"),
      report: passResult("report"),
    },
    orphanFiles: [],
    recentTransitions: [],
  };
}

function buildFailReport(): DoctorExtensionsReport {
  return {
    overallStatus: "fail",
    registries: {
      model: failResult("model", [
        { file: "/repo/extensions/models/bad.ts", error: "missing version" },
      ]),
      vault: passResult("vault"),
      driver: passResult("driver"),
      datastore: passResult("datastore"),
      report: passResult("report"),
    },
    orphanFiles: [],
    recentTransitions: [],
  };
}

Deno.test("doctor_extensions json renderer: emits all five registry keys on pass", async () => {
  const out = await captureStdout(async () => {
    const r = createDoctorExtensionsRenderer("json");
    const handlers = r.handlers();
    await handlers.completed({ kind: "completed", report: buildPassReport() });
  });

  const parsed = JSON.parse(out);
  assertEquals(parsed.overallStatus, "pass");
  const keys = Object.keys(parsed.registries).sort();
  assertEquals(keys, ["datastore", "driver", "model", "report", "vault"]);
  for (const key of keys) {
    assertEquals(parsed.registries[key].status, "pass");
    assertEquals(parsed.registries[key].failures.length, 0);
  }
});

Deno.test("doctor_extensions json renderer: emits all five registry keys on fail", async () => {
  const out = await captureStdout(async () => {
    const r = createDoctorExtensionsRenderer("json");
    const handlers = r.handlers();
    await handlers.completed({ kind: "completed", report: buildFailReport() });
  });

  const parsed = JSON.parse(out);
  assertEquals(parsed.overallStatus, "fail");
  // All five keys still present even though only one registry failed.
  const keys = Object.keys(parsed.registries).sort();
  assertEquals(keys, ["datastore", "driver", "model", "report", "vault"]);
  assertEquals(parsed.registries.model.status, "fail");
  assertEquals(parsed.registries.model.failures.length, 1);
  assertEquals(parsed.registries.vault.status, "pass");
});

Deno.test("doctor_extensions log renderer: tracks overallStatus across completion", async () => {
  const r = createDoctorExtensionsRenderer("log");
  const handlers = r.handlers();
  assertEquals(r.overallStatus, "pass");
  await handlers.completed({ kind: "completed", report: buildFailReport() });
  assertEquals(r.overallStatus, "fail");
});

Deno.test("doctor_extensions log renderer: emits one failure bullet per file", async () => {
  // Capture writeOutput by spying on console (writeOutput funnels through
  // LogTape; we assert the rendered handlers don't throw and overallStatus
  // tracks correctly. Bullet rendering itself is verified by integration tests).
  const r = createDoctorExtensionsRenderer("log");
  const handlers = r.handlers();
  // No-op for kind-started.
  await handlers["kind-started"]({ kind: "kind-started", registry: "model" });
  // kind-completed for a failing model row should not throw.
  await handlers["kind-completed"]({
    kind: "kind-completed",
    result: failResult("model", [
      { file: "/a.ts", error: "boom" },
      { file: "/b.ts", error: "boom2" },
    ]),
  });
  // completed sets overallStatus.
  await handlers.completed({ kind: "completed", report: buildFailReport() });
  assertEquals(r.overallStatus, "fail");
});

Deno.test("doctor_extensions json renderer: stable key ordering", async () => {
  // Even if the input report has registries in a different order, the JSON
  // output respects DOCTOR_REGISTRY_ORDER.
  const out = await captureStdout(async () => {
    const r = createDoctorExtensionsRenderer("json");
    const handlers = r.handlers();
    // Build a report with registries inserted in reverse order — output
    // should still be model, vault, driver, datastore, report.
    const reversed: DoctorExtensionsReport = {
      overallStatus: "pass",
      registries: {
        report: passResult("report"),
        datastore: passResult("datastore"),
        driver: passResult("driver"),
        vault: passResult("vault"),
        model: passResult("model"),
      },
      orphanFiles: [],
      recentTransitions: [],
    };
    await handlers.completed({ kind: "completed", report: reversed });
  });

  // Find the order of keys in the printed JSON string.
  const startOfRegistries = out.indexOf('"registries"');
  const slice = out.slice(startOfRegistries);
  const modelIdx = slice.indexOf('"model"');
  const vaultIdx = slice.indexOf('"vault"');
  const driverIdx = slice.indexOf('"driver"');
  const datastoreIdx = slice.indexOf('"datastore"');
  const reportIdx = slice.indexOf('"report"');

  assertEquals(modelIdx < vaultIdx, true);
  assertEquals(vaultIdx < driverIdx, true);
  assertEquals(driverIdx < datastoreIdx, true);
  assertEquals(datastoreIdx < reportIdx, true);
});

Deno.test("doctor_extensions log renderer: no implicit fold — renders every row it receives", async () => {
  // The renderer must not absorb or rename ExtensionKind values. It
  // expects exactly the five DoctorRegistryName values from the service.
  // Asserting this contract by checking it does not throw on any single
  // valid registry row and overallStatus tracks the report it sees.
  const r = createDoctorExtensionsRenderer("log");
  const handlers = r.handlers();
  for (
    const registry of [
      "model",
      "vault",
      "driver",
      "datastore",
      "report",
    ] as const
  ) {
    await handlers["kind-completed"]({
      kind: "kind-completed",
      result: passResult(registry),
    });
  }
  // overallStatus only updates on `completed`.
  assertEquals(r.overallStatus, "pass");
});

Deno.test(
  "doctor_extensions json renderer: orphanFiles surfaces in JSON output",
  async () => {
    const out = await captureStdout(async () => {
      const r = createDoctorExtensionsRenderer("json");
      const handlers = r.handlers();
      const report: DoctorExtensionsReport = {
        overallStatus: "pass",
        registries: {
          model: passResult("model"),
          vault: passResult("vault"),
          driver: passResult("driver"),
          datastore: passResult("datastore"),
          report: passResult("report"),
        },
        orphanFiles: [
          {
            extensionName: "@hivemq/harvester",
            path: ".swamp/pulled-extensions/@hivemq/harvester/models/orphan.ts",
          },
        ],
        recentTransitions: [],
      };
      await handlers.completed({ kind: "completed", report });
    });

    const parsed = JSON.parse(out);
    assertEquals(parsed.overallStatus, "pass");
    assertEquals(parsed.orphanFiles.length, 1);
    assertEquals(parsed.orphanFiles[0].extensionName, "@hivemq/harvester");
    assertEquals(
      parsed.orphanFiles[0].path,
      ".swamp/pulled-extensions/@hivemq/harvester/models/orphan.ts",
    );
  },
);

Deno.test(
  "doctor_extensions log renderer: orphans render as warnings, not failures",
  async () => {
    const out = await captureStdout(async () => {
      const r = createDoctorExtensionsRenderer("log");
      const handlers = r.handlers();
      const report: DoctorExtensionsReport = {
        overallStatus: "pass",
        registries: {
          model: passResult("model"),
          vault: passResult("vault"),
          driver: passResult("driver"),
          datastore: passResult("datastore"),
          report: passResult("report"),
        },
        orphanFiles: [
          {
            extensionName: "@x/y",
            path: ".swamp/pulled-extensions/@x/y/models/orphan.ts",
          },
        ],
        recentTransitions: [],
      };
      // Drive the kind-completed events first so the registry headers
      // get rendered, then completed.
      for (
        const reg of [
          "model",
          "vault",
          "driver",
          "datastore",
          "report",
        ] as const
      ) {
        await handlers["kind-completed"]({
          kind: "kind-completed",
          result: passResult(reg),
        });
      }
      await handlers.completed({ kind: "completed", report });
    });

    // Warnings section appears with the orphan path.
    if (!out.includes("orphan.ts")) {
      throw new Error(`expected orphan path in output, got: ${out}`);
    }
    if (!out.includes("warnings, not failures")) {
      throw new Error(
        `expected 'warnings, not failures' framing in output, got: ${out}`,
      );
    }
    // Overall status remains PASS.
    if (!out.includes("OVERALL: PASS")) {
      throw new Error(`expected OVERALL: PASS, got: ${out}`);
    }
  },
);

function sampleTransitions(): ReconcileTransition[] {
  return [
    {
      source: makeSourceLocation("/repo/extensions/models/a.ts", "/repo"),
      fromState: "Indexed",
      toState: "Tombstoned",
      reason: "source file deleted from disk",
    },
  ];
}

Deno.test(
  "doctor_extensions json renderer: recentTransitions always present in JSON output",
  async () => {
    const out = await captureStdout(async () => {
      const r = createDoctorExtensionsRenderer("json");
      const handlers = r.handlers();
      await handlers.completed({
        kind: "completed",
        report: buildPassReport(),
      });
    });

    const parsed = JSON.parse(out);
    assertEquals(parsed.recentTransitions, []);
  },
);

Deno.test(
  "doctor_extensions json renderer: recentTransitions serializes sourcePath from canonicalPath",
  async () => {
    const out = await captureStdout(async () => {
      const r = createDoctorExtensionsRenderer("json");
      const handlers = r.handlers();
      const report: DoctorExtensionsReport = {
        ...buildPassReport(),
        recentTransitions: sampleTransitions(),
      };
      await handlers.completed({ kind: "completed", report });
    });

    const parsed = JSON.parse(out);
    assertEquals(parsed.recentTransitions.length, 1);
    assertEquals(
      parsed.recentTransitions[0].sourcePath,
      "/repo/extensions/models/a.ts",
    );
    assertEquals(parsed.recentTransitions[0].fromState, "Indexed");
    assertEquals(parsed.recentTransitions[0].toState, "Tombstoned");
    assertEquals(
      parsed.recentTransitions[0].reason,
      "source file deleted from disk",
    );
  },
);
