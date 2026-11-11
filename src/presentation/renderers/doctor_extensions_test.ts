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

import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type {
  DoctorExtensionsReport,
  DoctorRegistryName,
  DoctorRegistryResult,
} from "../../libswamp/extensions/doctor.ts";
import type { ReconcileTransition } from "../../libswamp/extensions/reconcile_from_disk_service.ts";
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

async function captureConsole(
  fn: () => void | Promise<void>,
): Promise<string> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => [m, console[m]] as const);
  for (const [m] of originals) {
    console[m] = (...args: unknown[]) => {
      lines.push(
        args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
      );
    };
  }
  try {
    await fn();
  } finally {
    for (const [m, orig] of originals) {
      console[m] = orig;
    }
  }
  // deno-lint-ignore no-control-regex
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function passResult(registry: DoctorRegistryName): DoctorRegistryResult {
  return { registry, status: "pass" };
}

function failResult(
  registry: DoctorRegistryName,
): DoctorRegistryResult {
  return { registry, status: "fail" };
}

function buildPassReport(): DoctorExtensionsReport {
  return {
    overallStatus: "pass",
    registries: {
      model: passResult("model"),
      vault: passResult("vault"),
      datastore: passResult("datastore"),
      report: passResult("report"),
      webhook: passResult("webhook"),
    },
    orphanFiles: [],
    recentTransitions: [],
    warnings: [],
    memberCollisions: [],
    missingExtensions: [],
  };
}

function buildFailReport(): DoctorExtensionsReport {
  return {
    overallStatus: "fail",
    registries: {
      model: failResult("model"),
      vault: passResult("vault"),
      datastore: passResult("datastore"),
      report: passResult("report"),
      webhook: passResult("webhook"),
    },
    orphanFiles: [],
    recentTransitions: [],
    warnings: [],
    memberCollisions: [],
    missingExtensions: [],
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
  assertEquals(keys, ["datastore", "model", "report", "vault", "webhook"]);
  for (const key of keys) {
    assertEquals(parsed.registries[key].status, "pass");
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
  const keys = Object.keys(parsed.registries).sort();
  assertEquals(keys, ["datastore", "model", "report", "vault", "webhook"]);
  assertEquals(parsed.registries.model.status, "fail");
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
  // writeOutput funnels through LogTape, so assert only that the handlers do
  // not throw and overallStatus tracks the report
  const r = createDoctorExtensionsRenderer("log");
  const handlers = r.handlers();
  await handlers["kind-started"]({ kind: "kind-started", registry: "model" });
  await handlers["kind-completed"]({
    kind: "kind-completed",
    result: failResult("model"),
  });
  await handlers.completed({ kind: "completed", report: buildFailReport() });
  assertEquals(r.overallStatus, "fail");
});

Deno.test("doctor_extensions json renderer: stable key ordering", async () => {
  const out = await captureStdout(async () => {
    const r = createDoctorExtensionsRenderer("json");
    const handlers = r.handlers();
    const reversed: DoctorExtensionsReport = {
      overallStatus: "pass",
      registries: {
        webhook: passResult("webhook"),
        report: passResult("report"),
        datastore: passResult("datastore"),
        vault: passResult("vault"),
        model: passResult("model"),
      },
      orphanFiles: [],
      recentTransitions: [],
      warnings: [],
      memberCollisions: [],
      missingExtensions: [],
    };
    await handlers.completed({ kind: "completed", report: reversed });
  });

  const startOfRegistries = out.indexOf('"registries"');
  const slice = out.slice(startOfRegistries);
  const modelIdx = slice.indexOf('"model"');
  const vaultIdx = slice.indexOf('"vault"');
  const datastoreIdx = slice.indexOf('"datastore"');
  const reportIdx = slice.indexOf('"report"');
  const webhookIdx = slice.indexOf('"webhook"');

  assertEquals(modelIdx < vaultIdx, true);
  assertEquals(vaultIdx < datastoreIdx, true);
  assertEquals(datastoreIdx < reportIdx, true);
  assertEquals(reportIdx < webhookIdx, true);
});

Deno.test("doctor_extensions log renderer: no implicit fold — renders every row it receives", async () => {
  const r = createDoctorExtensionsRenderer("log");
  const handlers = r.handlers();
  for (
    const registry of [
      "model",
      "vault",
      "datastore",
      "report",
    ] as const
  ) {
    await handlers["kind-completed"]({
      kind: "kind-completed",
      result: passResult(registry),
    });
  }
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
          datastore: passResult("datastore"),
          report: passResult("report"),
          webhook: passResult("webhook"),
        },
        orphanFiles: [
          {
            extensionName: "@hivemq/harvester",
            path: ".swamp/pulled-extensions/@hivemq/harvester/models/orphan.ts",
          },
        ],
        recentTransitions: [],
        warnings: [],
        memberCollisions: [],
        missingExtensions: [],
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
          datastore: passResult("datastore"),
          report: passResult("report"),
          webhook: passResult("webhook"),
        },
        orphanFiles: [
          {
            extensionName: "@x/y",
            path: ".swamp/pulled-extensions/@x/y/models/orphan.ts",
          },
        ],
        recentTransitions: [],
        warnings: [],
        memberCollisions: [],
        missingExtensions: [],
      };
      for (
        const reg of [
          "model",
          "vault",
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

    if (!out.includes("orphan.ts")) {
      throw new Error(`expected orphan path in output, got: ${out}`);
    }
    if (!out.includes("warnings, not failures")) {
      throw new Error(
        `expected 'warnings, not failures' framing in output, got: ${out}`,
      );
    }
    if (!out.includes("OVERALL: PASS")) {
      throw new Error(`expected OVERALL: PASS, got: ${out}`);
    }
  },
);

function collisionReport(): DoctorExtensionsReport {
  return {
    ...buildPassReport(),
    warnings: [
      {
        sourcePath: "/repo/.swamp/pulled-extensions/@x/y/models/p.ts",
        category: "MemberCollision",
        message: "method 'probe' ... which wins",
      },
      {
        sourcePath: "/repo/extensions/models/wrapped.ts",
        category: "TypeExtractionFailed",
        message: "type could not be read statically",
      },
    ],
    memberCollisions: [
      {
        type: "@x/base",
        memberKind: "method",
        name: "probe",
        winner: "/repo/extensions/models/local.ts",
        losers: ["/repo/.swamp/pulled-extensions/@x/y/models/p.ts"],
      },
      {
        type: "@x/base",
        memberKind: "check",
        name: "policy",
        winner: null,
        losers: ["/repo/extensions/models/local.ts"],
      },
    ],
  };
}

Deno.test("doctor_extensions log renderer: lists member collisions with their winners (swamp-club#2562)", async () => {
  const out = stripAnsiCode(
    await captureStdout(async () => {
      const r = createDoctorExtensionsRenderer("log");
      await r.handlers().completed({
        kind: "completed",
        report: collisionReport(),
      });
    }),
  );

  assertStringIncludes(out, "2 extension member collision(s)");
  assertStringIncludes(out, "@x/base method 'probe'");
  assertStringIncludes(out, "wins: /repo/extensions/models/local.ts");
  assertStringIncludes(
    out,
    "not registered: /repo/.swamp/pulled-extensions/@x/y/models/p.ts",
  );
  assertStringIncludes(out, "wins: the base behavior");
  assertStringIncludes(out, "1 warning(s)");
  assertStringIncludes(
    out,
    "/repo/extensions/models/wrapped.ts [TypeExtractionFailed]",
  );
  assertFalse(out.includes("which wins"));
  assertStringIncludes(out, "OVERALL: PASS");
});

Deno.test("doctor_extensions json renderer: carries member collisions and warning categories (swamp-club#2562)", async () => {
  const out = await captureStdout(async () => {
    const r = createDoctorExtensionsRenderer("json");
    await r.handlers().completed({
      kind: "completed",
      report: collisionReport(),
    });
  });

  const parsed = JSON.parse(out);
  assertEquals(parsed.overallStatus, "pass");
  assertEquals(parsed.memberCollisions, collisionReport().memberCollisions);
  assertEquals(
    parsed.warnings.map((w: { category: string }) => w.category),
    ["MemberCollision", "TypeExtractionFailed"],
  );
});

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

Deno.test(
  "doctor_extensions json renderer: denoPath included when provided",
  async () => {
    const out = await captureStdout(async () => {
      const r = createDoctorExtensionsRenderer("json", {
        denoPath: "/home/user/.swamp/deno/deno",
      });
      const handlers = r.handlers();
      await handlers.completed({
        kind: "completed",
        report: buildPassReport(),
      });
    });

    const parsed = JSON.parse(out);
    assertEquals(parsed.denoPath, "/home/user/.swamp/deno/deno");
  },
);

Deno.test(
  "doctor_extensions json renderer: denoPath omitted when not provided",
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
    assertFalse("denoPath" in parsed);
  },
);

Deno.test(
  "doctor_extensions json renderer: rescanSkipped carries the reason when the rescan did not run",
  async () => {
    const out = await captureStdout(async () => {
      const r = createDoctorExtensionsRenderer("json");
      const handlers = r.handlers();
      await handlers.completed({
        kind: "completed",
        report: {
          ...buildPassReport(),
          rescanSkipped: {
            reason: "Cannot resolve the s3 datastore",
            repairSkipped: true,
          },
        },
      });
    });

    const parsed = JSON.parse(out);
    assertEquals(parsed.rescanSkipped, {
      reason: "Cannot resolve the s3 datastore",
      repairSkipped: true,
    });
    assertFalse("repairReport" in parsed);
  },
);

Deno.test(
  "doctor_extensions json renderer: rescanSkipped omitted when the rescan ran",
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
    assertFalse("rescanSkipped" in parsed);
  },
);

Deno.test(
  "doctor_extensions log renderer: warns when the rescan and repairs were skipped",
  async () => {
    const out = await captureConsole(async () => {
      const r = createDoctorExtensionsRenderer("log");
      const handlers = r.handlers();
      await handlers.completed({
        kind: "completed",
        report: {
          ...buildPassReport(),
          rescanSkipped: {
            reason: "Cannot resolve the s3 datastore",
            repairSkipped: true,
          },
        },
      });
    });

    assertStringIncludes(
      out,
      "Skipped the catalog rescan and repairs: Cannot resolve the s3 datastore",
    );
  },
);

function missingReport(): DoctorExtensionsReport {
  return {
    ...buildPassReport(),
    overallStatus: "fail",
    missingExtensions: [
      {
        name: "@example/missing",
        state: "absent",
        expectedPath: ".swamp/pulled-extensions/@example/missing",
        missingFiles: [
          ".swamp/pulled-extensions/@example/missing/a.ts",
          ".swamp/pulled-extensions/@example/missing/b.ts",
          ".swamp/pulled-extensions/@example/missing/c.ts",
        ],
        missingFileCount: 5,
        installsOnNextUse: false,
        remedy: "install",
      },
      {
        name: "@example/later",
        state: "absent",
        expectedPath: ".swamp/pulled-extensions/@example/later",
        missingFiles: [".swamp/pulled-extensions/@example/later/m.yaml"],
        missingFileCount: 1,
        installsOnNextUse: true,
        remedy: "nextUse",
      },
    ],
  };
}

Deno.test("doctor_extensions log renderer: a missing pinned extension renders as a failure, one installed on next use as advisory", async () => {
  const out = stripAnsiCode(
    await captureStdout(async () => {
      const r = createDoctorExtensionsRenderer("log");
      await r.handlers().completed({
        kind: "completed",
        report: missingReport(),
      });
    }),
  );

  assertStringIncludes(out, "1 pinned extension(s) missing from disk:");
  assertStringIncludes(
    out,
    "@example/missing  absent  .swamp/pulled-extensions/@example/missing",
  );
  assertStringIncludes(out, "(+2 more)");
  assertStringIncludes(out, "Run 'swamp extension install' to restore it.");
  assertStringIncludes(
    out,
    "1 pinned extension(s) not on disk, installed on next use (advisory, not failures):",
  );
  assertStringIncludes(out, "@example/later");
  assertStringIncludes(
    out,
    "5 passed, 0 failed, 1 missing pinned extension(s) — OVERALL: FAIL",
  );
});

Deno.test("doctor_extensions log renderer: no missing extensions leaves the summary line unchanged", async () => {
  const out = stripAnsiCode(
    await captureStdout(async () => {
      const r = createDoctorExtensionsRenderer("log");
      await r.handlers().completed({
        kind: "completed",
        report: buildPassReport(),
      });
    }),
  );

  assertFalse(out.includes("pinned extension"));
  assertStringIncludes(out, "5 passed, 0 failed — OVERALL: PASS");
});

Deno.test("doctor_extensions json renderer: missingExtensions is always present, after the existing keys", async () => {
  const empty = JSON.parse(
    await captureStdout(async () => {
      const r = createDoctorExtensionsRenderer("json");
      await r.handlers().completed({
        kind: "completed",
        report: buildPassReport(),
      });
    }),
  );
  assertEquals(empty.missingExtensions, []);
  const keys = Object.keys(empty);
  assertEquals(keys.indexOf("missingExtensions"), keys.length - 1);

  const r = createDoctorExtensionsRenderer("json");
  const parsed = JSON.parse(
    await captureStdout(async () => {
      await r.handlers().completed({
        kind: "completed",
        report: missingReport(),
      });
    }),
  );
  assertEquals(r.overallStatus, "fail");
  assertEquals(parsed.overallStatus, "fail");
  assertEquals(
    parsed.missingExtensions.map((m: { name: string }) => m.name),
    ["@example/missing", "@example/later"],
  );
  assertEquals(parsed.missingExtensions[0].missingFileCount, 5);
});
