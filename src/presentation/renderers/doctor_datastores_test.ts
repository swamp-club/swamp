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
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  createDoctorDatastoresRenderer,
  retentionDetailLines,
  v3ContentDetailLines,
} from "./doctor_datastores.ts";
import type {
  DoctorDatastoresData,
  V3ContentSummary,
} from "../../libswamp/datastores/doctor_datastores.ts";
import {
  createCatalogDuplicateLatestRepairRenderer,
  createCatalogIndexRepairRenderer,
  createDatastoreFormatMarkerRepairRenderer,
  createPreV3RecordsRepairRenderer,
  createRepairDatastoresRenderer,
  createUnmigratedDataRepairRenderer,
  createUnreadableVersionsRepairRenderer,
  DatastoreRepairJsonReport,
  unreadableVersionsDetailLines,
} from "./doctor_datastores.ts";
import type {
  UnreadableRecordRepair,
  UnreadableVersionsSummary,
} from "../../libswamp/datastores/doctor_datastores.ts";
import { UserError } from "../../domain/errors.ts";
import type { RetentionCheckSummary } from "../../libswamp/datastores/retention_check.ts";

await initializeLogging({});

function captureStdout(fn: () => void): string {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

const SUMMARY: RetentionCheckSummary = {
  configured: true,
  automatic: true,
  checkedAt: "2026-10-15T00:00:00.000Z",
  kinds: [
    {
      kind: "workflowRuns",
      retention: "30d",
      cutoff: "2026-09-15T00:00:00.000Z",
      scanned: true,
      overdue: 3,
      items: [{ id: "wf/run-1", at: "2026-08-01T00:00:00.000Z" }],
      kept: 1,
      watermark: {
        lastPassAt: "2026-10-14T23:00:00.000Z",
        cutoff: "2026-09-14T23:00:00.000Z",
        complete: false,
      },
    },
    {
      kind: "bookkeeping",
      retention: "30d",
      cutoff: "2026-09-15T00:00:00.000Z",
      scanned: false,
      overdue: 0,
      items: [],
      kept: 0,
      watermark: null,
    },
  ],
  v3History: {
    oldestCommitAt: "2026-10-10T00:00:00.000Z",
    compactionBound: "2026-10-08T00:00:00.000Z",
    failBefore: "2026-10-07T00:00:00.000Z",
    overdue: false,
  },
};

function data(retentionFinding?: RetentionCheckSummary): DoctorDatastoresData {
  return {
    datastoreType: "filesystem",
    isCustom: false,
    healthFindings: [
      { check: "health", passed: true, message: "ok" },
      { check: "retention", passed: false, message: "3 item(s)" },
    ],
    vaultMismatchFindings: [],
    ...(retentionFinding ? { retentionFinding } : {}),
  };
}

Deno.test("createDoctorDatastoresRenderer: json mode carries the retention finding and fails on it", () => {
  const renderer = createDoctorDatastoresRenderer("json");
  const out = captureStdout(() =>
    renderer.handlers().completed({ kind: "completed", data: data(SUMMARY) })
  );
  const parsed = JSON.parse(out);
  assertEquals(parsed.overallStatus, "fail");
  assertEquals(parsed.retentionFinding, SUMMARY);
  assertEquals(renderer.overallStatus, "fail");
});

Deno.test("createDoctorDatastoresRenderer: json mode reports a null retention finding without --retention", () => {
  const renderer = createDoctorDatastoresRenderer("json");
  const out = captureStdout(() =>
    renderer.handlers().completed({ kind: "completed", data: data() })
  );
  assertEquals(JSON.parse(out).retentionFinding, null);
});

Deno.test("retentionDetailLines: lists overdue items, the rest as a count, watermarks and the v3 bound", () => {
  const text = stripAnsiCode(retentionDetailLines(SUMMARY).join("\n"));
  assertStringIncludes(text, "Retention: automatic on");
  assertStringIncludes(
    text,
    "workflowRuns 30d cutoff 2026-09-15T00:00:00.000Z",
  );
  assertStringIncludes(text, "3 older than cutoff");
  assertStringIncludes(text, "(1 kept by design)");
  assertStringIncludes(text, "• wf/run-1 2026-08-01T00:00:00.000Z");
  assertStringIncludes(text, "… and 2 more");
  assertStringIncludes(text, "last pass 2026-10-14T23:00:00.000Z");
  assertStringIncludes(text, "incomplete");
  assertStringIncludes(text, "serve bookkeeping");
  assertStringIncludes(
    text,
    "v3 history oldest commit 2026-10-10T00:00:00.000Z",
  );
  assertStringIncludes(
    text,
    "This check fails only for history older than 2026-10-07T00:00:00.000Z",
  );
  assertStringIncludes(text, "removed content leaves history about a day");
});

Deno.test("retentionDetailLines: says retention is not configured", () => {
  const text = stripAnsiCode(
    retentionDetailLines({ ...SUMMARY, configured: false }).join("\n"),
  );
  assertStringIncludes(text, "Retention: not configured");
  assertEquals(text.includes("workflowRuns"), false);
});

// --- swamp-club#3617: restoring a v3 datastore's lost format marker ---

const MARKER_REPAIR = {
  datastorePath: "/data/v3",
  markerPath: "/data/v3/datastore-format.json",
  marker: "absent" as const,
};

Deno.test("createDatastoreFormatMarkerRepairRenderer: json mode reports the preview, the restore and nothing to do (swamp-club#3617)", () => {
  const preview = createDatastoreFormatMarkerRepairRenderer("json");
  const out = captureStdout(() =>
    preview.handlers().preview({ kind: "preview", data: MARKER_REPAIR })
  );
  assertEquals(JSON.parse(out), {
    status: "format_marker_preview",
    ...MARKER_REPAIR,
  });
  assertEquals(preview.overallStatus, "preview");

  const restored = createDatastoreFormatMarkerRepairRenderer("json");
  assertEquals(
    JSON.parse(
      captureStdout(() =>
        restored.handlers().completed({
          kind: "completed",
          data: MARKER_REPAIR,
        })
      ),
    ),
    { status: "format_marker_restored", ...MARKER_REPAIR },
  );
  assertEquals(restored.overallStatus, "pass");

  const none = createDatastoreFormatMarkerRepairRenderer("json");
  assertEquals(
    JSON.parse(captureStdout(() =>
      none.handlers().not_needed({
        kind: "not_needed",
        datastorePath: "/data/v3",
      })
    )),
    { status: "format_marker_not_needed", datastorePath: "/data/v3" },
  );
});

Deno.test("createDatastoreFormatMarkerRepairRenderer: both modes fail with the error's message and code (swamp-club#3617)", () => {
  for (const mode of ["log", "json"] as const) {
    const renderer = createDatastoreFormatMarkerRepairRenderer(mode);
    let thrown: unknown;
    try {
      renderer.handlers().error({
        kind: "error",
        error: { code: "some_code", message: "not restored" },
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof UserError, true);
    assertEquals((thrown as UserError).message, "not restored");
    assertEquals((thrown as UserError).code, "some_code");
    assertEquals(renderer.overallStatus, "fail");
  }
});

Deno.test("createDatastoreFormatMarkerRepairRenderer: log mode previews, and restores as a pass (swamp-club#3617)", () => {
  const renderer = createDatastoreFormatMarkerRepairRenderer("log");
  renderer.handlers().preview({ kind: "preview", data: MARKER_REPAIR });
  assertEquals(renderer.overallStatus, "preview");
  renderer.handlers().completed({ kind: "completed", data: MARKER_REPAIR });
  assertEquals(renderer.overallStatus, "pass");
});

const V3_CONTENT: V3ContentSummary = {
  unreadableRecords: 12,
  unreadable: [{
    namespace: "",
    recordKey: "data/m/lost/1/raw",
    reason: "missing",
    chunk: "a".repeat(64),
    advice: "Write that data again.",
  }],
  atRiskCopies: 1,
  atRisk: [{
    namespace: "acme",
    sha256: "b".repeat(64),
    recordKey: "outputs/m/out.yaml",
    size: 42,
  }],
  atRiskDir: "/repo/.swamp/_read_model_v3/at-risk",
  atRiskAdvice: "Delete /repo/.swamp/_read_model_v3/at-risk to discard them.",
  tornChunks: 1,
  torn: [{
    namespace: "",
    sha256: "c".repeat(64),
    recordKey: "data/m/torn/1/raw",
    expectedSize: 10,
    size: 3,
    advice: "Write the record again.",
  }],
};

function v3Data(): DoctorDatastoresData {
  return {
    datastoreType: "filesystem",
    isCustom: false,
    healthFindings: [
      { check: "health", passed: true, message: "ok" },
      { check: "v3_content", passed: false, message: "12 record(s)" },
    ],
    vaultMismatchFindings: [],
    v3ContentFinding: V3_CONTENT,
  };
}

Deno.test("createDoctorDatastoresRenderer: json mode carries the v3 content finding and fails on it, null without one (swamp-club#3617)", () => {
  const renderer = createDoctorDatastoresRenderer("json");
  const parsed = JSON.parse(
    captureStdout(() =>
      renderer.handlers().completed({ kind: "completed", data: v3Data() })
    ),
  );
  assertEquals(parsed.overallStatus, "fail");
  assertEquals(parsed.v3ContentFinding, V3_CONTENT);
  assertEquals(
    JSON.parse(
      captureStdout(() =>
        createDoctorDatastoresRenderer("json").handlers().completed({
          kind: "completed",
          data: data(),
        })
      ),
    ).v3ContentFinding,
    null,
  );
});

Deno.test("v3ContentDetailLines: lists each kind with its advice and how many more there are (swamp-club#3617)", () => {
  const text = stripAnsiCode(v3ContentDetailLines(V3_CONTENT).join("\n"));
  assertStringIncludes(
    text,
    `data/m/lost/1/raw: chunk ${"a".repeat(64)} is missing`,
  );
  assertStringIncludes(text, "Write that data again.");
  assertStringIncludes(text, "… and 11 more");
  assertStringIncludes(text, "outputs/m/out.yaml [acme]: 42 bytes");
  assertStringIncludes(text, "to discard them.");
  assertStringIncludes(
    text,
    `${"c".repeat(64)}: 3 of 10 bytes, named by data/m/torn/1/raw`,
  );
  assertStringIncludes(text, "Write the record again.");
});

Deno.test("v3ContentDetailLines: a record whose missing chunk is not named reads as a chunk of its content (swamp-club#3617)", () => {
  const { chunk: _, ...unnamed } = V3_CONTENT.unreadable[0];
  const text = stripAnsiCode(
    v3ContentDetailLines({ ...V3_CONTENT, unreadable: [unnamed] }).join("\n"),
  );
  assertStringIncludes(
    text,
    "data/m/lost/1/raw: a chunk of its content is missing",
  );
});

Deno.test("createDoctorDatastoresRenderer: log mode fails on the v3 content finding (swamp-club#3617)", () => {
  const renderer = createDoctorDatastoresRenderer("log");
  renderer.handlers().completed({ kind: "completed", data: v3Data() });
  assertEquals(renderer.overallStatus, "fail");
});

// --- swamp-club#3690: moving aside a joining checkout's records ---

const PRE_V3_PREVIEW = {
  swampDir: "/repo/.swamp",
  recordDirs: ["data", "outputs"],
  preV3RecordsDir: "/repo/.swamp/pre-v3-records",
};

Deno.test("createPreV3RecordsRepairRenderer: json mode reports the preview, the move and nothing to do (swamp-club#3690)", () => {
  const preview = createPreV3RecordsRepairRenderer("json");
  assertEquals(
    JSON.parse(
      captureStdout(() =>
        preview.handlers().preview({ kind: "preview", data: PRE_V3_PREVIEW })
      ),
    ),
    { status: "pre_v3_records_preview", ...PRE_V3_PREVIEW },
  );
  assertEquals(preview.overallStatus, "preview");

  const moved = createPreV3RecordsRepairRenderer("json");
  const done = {
    ...PRE_V3_PREVIEW,
    destination: "/repo/.swamp/pre-v3-records/20261020T211321Z-abcd1234",
  };
  assertEquals(
    JSON.parse(
      captureStdout(() =>
        moved.handlers().completed({ kind: "completed", data: done })
      ),
    ),
    { status: "pre_v3_records_moved", ...done },
  );
  assertEquals(moved.overallStatus, "pass");

  const none = createPreV3RecordsRepairRenderer("json");
  assertEquals(
    JSON.parse(captureStdout(() =>
      none.handlers().not_needed({
        kind: "not_needed",
        swampDir: "/repo/.swamp",
      })
    )),
    { status: "pre_v3_records_not_needed", swampDir: "/repo/.swamp" },
  );
});

Deno.test("createPreV3RecordsRepairRenderer: both modes fail with the error's message and code, and log mode previews then passes (swamp-club#3690)", () => {
  for (const mode of ["log", "json"] as const) {
    const renderer = createPreV3RecordsRepairRenderer(mode);
    let thrown: unknown;
    try {
      renderer.handlers().error({
        kind: "error",
        error: { code: "some_code", message: "not moved" },
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown instanceof UserError, true);
    assertEquals((thrown as UserError).message, "not moved");
    assertEquals((thrown as UserError).code, "some_code");
    assertEquals(renderer.overallStatus, "fail");
  }
  const log = createPreV3RecordsRepairRenderer("log");
  log.handlers().preview({ kind: "preview", data: PRE_V3_PREVIEW });
  assertEquals(log.overallStatus, "preview");
  log.handlers().completed({
    kind: "completed",
    data: { ...PRE_V3_PREVIEW, destination: "/repo/.swamp/pre-v3-records/x" },
  });
  assertEquals(log.overallStatus, "pass");
});

Deno.test("createDoctorDatastoresRenderer: json mode carries the replica check's finding, null without one (swamp-club#3935)", () => {
  const finding = {
    status: "broken" as const,
    lineageFence: 1570,
    txid: "0000000000000070",
    checkedAt: "2026-10-25T18:30:00.000Z",
    error: "integrity check failed",
    copyCheck: "ok",
  };
  const render = (d: DoctorDatastoresData) =>
    JSON.parse(
      captureStdout(() =>
        createDoctorDatastoresRenderer("json").handlers().completed({
          kind: "completed",
          data: d,
        })
      ),
    );
  assertEquals(
    render({ ...data(), v3ReplicaRestorableFinding: finding })
      .v3ReplicaRestorableFinding,
    finding,
  );
  assertEquals(render(data()).v3ReplicaRestorableFinding, null);
});

Deno.test("DatastoreRepairJsonReport: the json repair renderers record their stage instead of printing, and print() writes one document (swamp-club#4011)", () => {
  const report = new DatastoreRepairJsonReport();
  const unmigrated = createUnmigratedDataRepairRenderer("json", report);
  const catalog = createCatalogIndexRepairRenderer("json", report);
  const duplicates = createCatalogDuplicateLatestRepairRenderer(
    "json",
    report,
  );
  const printed = captureStdout(() => {
    unmigrated.handlers().preview({
      kind: "preview",
      namespace: "team",
      directories: ["data"],
    });
    catalog.handlers().not_needed({ kind: "not_needed" });
    duplicates.handlers().preview({ kind: "preview", duplicateCount: 2 });
  });
  assertEquals(printed, "");
  assertEquals(unmigrated.overallStatus, "preview");

  assertEquals(JSON.parse(captureStdout(() => report.print())), {
    unmigrated: {
      status: "unmigrated_preview",
      namespace: "team",
      directories: ["data"],
    },
    unreadableVersions: null,
    catalog: { status: "catalog_not_needed" },
    duplicateLatest: { status: "duplicate_latest_preview", duplicateCount: 2 },
    contamination: null,
  });
});

Deno.test("DatastoreRepairJsonReport: log mode renderers leave the report empty (swamp-club#4011)", () => {
  const report = new DatastoreRepairJsonReport();
  const repair = createRepairDatastoresRenderer("log", report);
  const printed = captureStdout(() =>
    repair.handlers().not_needed({ kind: "not_needed" })
  );
  assertStringIncludes(stripAnsiCode(printed), "No namespace contamination");
  assertEquals(JSON.parse(captureStdout(() => report.print())), {
    unmigrated: null,
    unreadableVersions: null,
    catalog: null,
    duplicateLatest: null,
    contamination: null,
  });
});

// --- swamp-club#3955: unreadable data versions ---

const UNREADABLE: UnreadableVersionsSummary = {
  unreadableVersions: 3,
  records: 2,
  darkRecords: 1,
  findings: [
    {
      modelType: "@test/spec",
      modelId: "m-1",
      modelName: "spec",
      dataName: "state",
      version: 3,
      reason: "metadata_empty",
      latest: true,
      readableVersion: 2,
    },
    {
      modelType: "@test/spec",
      modelId: "m-1",
      modelName: "",
      dataName: "journal",
      version: null,
      reason: "marker_unreadable",
      latest: true,
      readableVersion: 4,
    },
  ],
};

Deno.test("unreadableVersionsDetailLines: names each version or marker, marks the latest, counts the rest and points at --repair (swamp-club#3955)", () => {
  const out = stripAnsiCode(
    unreadableVersionsDetailLines(UNREADABLE).join("\n"),
  );
  assertStringIncludes(out, "Unreadable data versions:");
  assertStringIncludes(
    out,
    "spec/state version 3 (latest): its metadata.yaml is empty",
  );
  assertStringIncludes(out, "m-1/journal latest marker (latest)");
  assertStringIncludes(out, "… and 1 more");
  assertStringIncludes(out, "swamp doctor datastores --repair");
});

Deno.test("createDoctorDatastoresRenderer: json mode carries the unreadable versions finding, null without one (swamp-club#3955)", () => {
  const render = (extra: Partial<DoctorDatastoresData>) => {
    const renderer = createDoctorDatastoresRenderer("json");
    return JSON.parse(captureStdout(() =>
      renderer.handlers().completed({
        kind: "completed",
        data: { ...data(), ...extra },
      })
    ));
  };
  assertEquals(
    render({ unreadableVersionsFinding: UNREADABLE }).unreadableVersionsFinding,
    UNREADABLE,
  );
  assertEquals(render({}).unreadableVersionsFinding, null);
});

const REPAIRS: UnreadableRecordRepair[] = [
  {
    modelType: "@test/spec",
    modelId: "m-1",
    modelName: "spec",
    dataName: "state",
    removeVersions: [3],
    markerUnreadable: false,
    becomesLatest: 2,
  },
  {
    modelType: "@test/spec",
    modelId: "m-1",
    modelName: "spec",
    dataName: "gone",
    removeVersions: [1],
    markerUnreadable: false,
    becomesLatest: null,
  },
  {
    modelType: "@test/spec",
    modelId: "m-1",
    modelName: "spec",
    dataName: "journal",
    removeVersions: [],
    markerUnreadable: true,
    becomesLatest: 4,
  },
];

Deno.test("createUnreadableVersionsRepairRenderer: log mode previews each record, then reports what it removed (swamp-club#3955)", () => {
  const renderer = createUnreadableVersionsRepairRenderer(
    "log",
    new DatastoreRepairJsonReport(),
  );
  const preview = stripAnsiCode(
    captureStdout(() =>
      renderer.handlers().preview({ kind: "preview", records: REPAIRS })
    ),
  );
  assertEquals(renderer.overallStatus, "preview");
  assertStringIncludes(
    preview,
    "spec/state: remove version(s) 3; version 2 is latest",
  );
  assertStringIncludes(
    preview,
    "spec/gone: remove version(s) 1; no readable version is left, so the record is removed",
  );
  assertStringIncludes(
    preview,
    "spec/journal: rewrite its latest marker; version 4 is latest",
  );
  assertStringIncludes(preview, "Run with -y to proceed.");

  const done = stripAnsiCode(captureStdout(() =>
    renderer.handlers().completed({
      kind: "completed",
      result: {
        records: REPAIRS,
        versionsRemoved: 2,
        recordsRemoved: 1,
        versionsKept: 1,
      },
    })
  ));
  assertEquals(renderer.overallStatus, "pass");
  assertStringIncludes(
    done,
    "spec/state: removed version(s) 3; version 2 is latest",
  );
  assertStringIncludes(done, "Removed 2 version(s); 1 record(s)");
  assertStringIncludes(done, "Kept 1 version(s)");

  const absent = stripAnsiCode(
    captureStdout(() =>
      renderer.handlers().completed({
        kind: "completed",
        result: {
          records: [{ ...REPAIRS[1], removed: false }],
          versionsRemoved: 1,
          recordsRemoved: 0,
          versionsKept: 0,
        },
      })
    ),
  );
  assertStringIncludes(
    absent,
    "spec/gone: removed version(s) 1; no readable version is left, so the record reads as absent",
  );
});

Deno.test("createUnreadableVersionsRepairRenderer: json mode records its stage in the one repair document (swamp-club#3955)", () => {
  const report = new DatastoreRepairJsonReport();
  const renderer = createUnreadableVersionsRepairRenderer("json", report);
  const printed = captureStdout(() =>
    renderer.handlers().preview({ kind: "preview", records: REPAIRS })
  );
  assertEquals(printed, "");
  const doc = JSON.parse(captureStdout(() => report.print()));
  assertEquals(doc.unreadableVersions, {
    status: "unreadable_versions_preview",
    records: REPAIRS,
  });

  const notNeeded = new DatastoreRepairJsonReport();
  createUnreadableVersionsRepairRenderer("json", notNeeded).handlers()
    .not_needed({ kind: "not_needed" });
  assertEquals(
    JSON.parse(captureStdout(() => notNeeded.print())).unreadableVersions,
    { status: "unreadable_versions_not_needed" },
  );
});
