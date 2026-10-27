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
import {
  composeScore,
  gradeForPercentage,
  percentageIfProvisionalEarned,
  RUBRIC_VERSION,
  type RubricInputs,
  type VersionAnalysis,
} from "./score.ts";
import { dependencyTrustEarnedPoints } from "../dependency_audit/points.ts";

function analysis(overrides: Partial<VersionAnalysis> = {}): VersionAnalysis {
  return {
    hasReadme: true,
    hasReadmeExamples: true,
    allEntrypointsDocs: true,
    percentageDocumentedSymbols: 1,
    allFastCheck: true,
    readmeLength: 800,
    readmeCodeBlockCount: 3,
    hasLicenseFile: true,
    ...overrides,
  };
}

function inputs(overrides: Partial<RubricInputs> = {}): RubricInputs {
  return {
    scoredWith: RUBRIC_VERSION,
    analysis: analysis(),
    licenseDeclared: true,
    dependencyTrust: {
      earnedPoints: 2,
      blockerCount: 0,
      notAuditedCount: 0,
      notAuditedFixes: [],
      looseCount: 0,
    },
    secretSafeDocs: true,
    description: "An extension",
    platforms: [],
    repository: {
      kind: "confirmed",
      publicRepositoryVerified: true,
      privateSourceAttested: false,
    },
    docAnalysisError: null,
    ...overrides,
  };
}

function byId(score: ReturnType<typeof composeScore>) {
  return new Map(score.factors.map((f) => [f.id, f]));
}

Deno.test("composeScore: a confirmed perfect version earns 16 of 16 in the registry's row order", () => {
  const score = composeScore(inputs());
  assertEquals(score.rubricVersion, RUBRIC_VERSION);
  assertEquals([score.earnedPoints, score.maxPoints], [16, 16]);
  assertEquals(score.provisionalPoints, 0);
  assertEquals(score.percentage, 100);
  assertEquals(score.factors.map((f) => f.id), [
    "has-readme",
    "readme-example",
    "rich-readme",
    "symbols-docs",
    "fast-check",
    "dependency-trust",
    "secret-safe-docs",
    "description",
    "platforms",
    "has-license",
    "license-file",
    "repository-verified",
  ]);
  assertEquals(
    score.factors.filter((f) => f.category === "per-package").map((f) => f.id),
    ["description", "platforms", "repository-verified"],
  );
});

Deno.test("composeScore: an unanalysed version reads pending on every per-version row", () => {
  const score = composeScore(
    inputs({
      analysis: null,
      licenseDeclared: null,
      dependencyTrust: null,
      secretSafeDocs: null,
    }),
  );
  const rows = byId(score);
  for (
    const id of [
      "has-readme",
      "readme-example",
      "rich-readme",
      "symbols-docs",
      "fast-check",
      "dependency-trust",
      "secret-safe-docs",
      "has-license",
      "license-file",
    ]
  ) {
    assertEquals(rows.get(id)?.status, "pending", id);
    assertEquals(rows.get(id)?.remediation, undefined, id);
  }
  // description 1 + platforms 2 + repository 2
  assertEquals(score.earnedPoints, 5);
  assertEquals(score.percentage, Math.floor(500 / 16));
});

Deno.test("composeScore: a version scored before v3 or v4 keeps the rows and maximum of its rubric", () => {
  const v2 = composeScore(inputs({ scoredWith: 2 }));
  assertEquals(byId(v2).has("dependency-trust"), false);
  assertEquals(byId(v2).has("secret-safe-docs"), false);
  assertEquals(v2.maxPoints, 13);
  const v3 = composeScore(inputs({ scoredWith: 3 }));
  assertEquals(byId(v3).has("dependency-trust"), true);
  assertEquals(byId(v3).has("secret-safe-docs"), false);
  assertEquals(v3.maxPoints, 15);
  assertEquals(composeScore(inputs({ scoredWith: 4 })).maxPoints, 16);
});

Deno.test("composeScore: a version with no README scores rich-readme missing, not pending", () => {
  const score = composeScore(
    inputs({
      analysis: analysis({
        hasReadme: false,
        readmeLength: null,
        readmeCodeBlockCount: null,
      }),
    }),
  );
  const row = byId(score).get("rich-readme")!;
  assertEquals(row.status, "missing");
  assertStringIncludes(row.remediation ?? "", "README");
});

Deno.test("composeScore: dependency-trust at one of two points is partial", () => {
  const score = composeScore(
    inputs({
      dependencyTrust: {
        earnedPoints: 1,
        blockerCount: 0,
        notAuditedCount: 0,
        notAuditedFixes: [],
        looseCount: 3,
      },
    }),
  );
  const row = byId(score).get("dependency-trust")!;
  assertEquals([row.earnedPoints, row.status], [1, "partial"]);
  assertEquals(row.label, "Dependencies pass trust audit");
  assertStringIncludes(row.remediation ?? "", "3 loose dependency specifier");
});

Deno.test("composeScore: unaudited code and a broken canonical form each name their cause and fix", () => {
  for (
    const [fix, why, remedy] of [
      [
        "origin",
        "the code comes from outside npm and JSR",
        "Replace it with an npm: or jsr: package.",
      ],
      [
        "canonical",
        "the archive breaks the canonical shipped form",
        "Push again with `swamp extension push`",
      ],
    ] as const
  ) {
    const score = composeScore(
      inputs({
        dependencyTrust: {
          earnedPoints: 0,
          blockerCount: 0,
          notAuditedCount: 1,
          notAuditedFixes: [fix],
          looseCount: 0,
        },
      }),
    );
    const row = byId(score).get("dependency-trust")!;
    assertEquals(row.earnedPoints, 0);
    assertStringIncludes(row.remediation ?? "", why);
    assertStringIncludes(row.remediation ?? "", remedy);
  }
});

Deno.test("composeScore: a description must be non-blank after trimming", () => {
  for (
    const [description, status] of [
      ["x", "earned"],
      ["", "missing"],
      ["  \n", "missing"],
      [undefined, "missing"],
    ] as const
  ) {
    assertEquals(
      byId(composeScore(inputs({ description }))).get("description")?.status,
      status,
      JSON.stringify(description),
    );
  }
});

Deno.test("composeScore: a confirmed repository earns through a public repository or private source attestation", () => {
  const cases = [
    [true, false, "earned", "Verified public repository"],
    [false, true, "earned", "Private repository (collective attested)"],
    [false, false, "missing", "Verified public repository"],
  ] as const;
  for (
    const [publicRepositoryVerified, privateSourceAttested, status, label]
      of cases
  ) {
    const row = byId(
      composeScore(
        inputs({
          repository: {
            kind: "confirmed",
            publicRepositoryVerified,
            privateSourceAttested,
          },
        }),
      ),
    ).get("repository-verified")!;
    assertEquals([row.status, row.label], [status, label]);
  }
});

Deno.test("composeScore: a predicted repository is provisional and counts as not earned yet", () => {
  const score = composeScore(
    inputs({
      repository: {
        kind: "predicted",
        repository: "https://codeberg.org/o/r.git",
        privateSource: { kind: "unknown" },
      },
    }),
  );
  assertEquals(byId(score).get("repository-verified")?.status, "provisional");
  assertEquals(score.provisionalPoints, 2);
  assertEquals([score.earnedPoints, score.maxPoints], [14, 16]);
  // the registry divides by every row's points, so the divisor stays 16
  assertEquals(score.percentage, 87);
  assertEquals(percentageIfProvisionalEarned(score), 100);
});

Deno.test("composeScore: a predicted attested private source is earned, as the registry awards it on the attestation alone", () => {
  const score = composeScore(
    inputs({
      repository: {
        kind: "predicted",
        repository: undefined,
        privateSource: { kind: "attested" },
      },
    }),
  );
  const row = byId(score).get("repository-verified")!;
  assertEquals(
    [row.status, row.label, row.earnedPoints, row.remediation],
    ["earned", "Private repository (collective attested)", 2, undefined],
  );
  assertEquals(score.provisionalPoints, 0);
  assertEquals([score.earnedPoints, score.maxPoints], [16, 16]);
  assertEquals(score.percentage, 100);
});

Deno.test("composeScore: a predicted repository the registry cannot verify says why", () => {
  const row = byId(
    composeScore(
      inputs({
        repository: {
          kind: "predicted",
          repository: "https://github.com/only-owner",
          privateSource: {
            kind: "not_attested",
            reason: "public_extension",
          },
        },
      }),
    ),
  ).get("repository-verified")!;
  assertEquals(row.status, "missing");
  assertStringIncludes(row.remediation ?? "", "only private extensions");
});

Deno.test("composeScore: the percentage floors", () => {
  const score = composeScore(
    inputs({ analysis: analysis({ hasLicenseFile: false }) }),
  );
  assertEquals(score.percentage, Math.floor((15 * 100) / 16));
});

Deno.test("dependencyTrustEarnedPoints: 2, 1 for loose specifiers, 0 for a blocker or an unaudited dependency", () => {
  const none = { blockerCount: 0, notAuditedCount: 0, looseCount: 0 };
  assertEquals(dependencyTrustEarnedPoints(none), 2);
  assertEquals(dependencyTrustEarnedPoints({ ...none, looseCount: 4 }), 1);
  assertEquals(
    dependencyTrustEarnedPoints({ ...none, blockerCount: 1, looseCount: 4 }),
    0,
  );
  assertEquals(dependencyTrustEarnedPoints({ ...none, notAuditedCount: 1 }), 0);
});

Deno.test("gradeForPercentage: thresholds at 90, 75, 60 and 40", () => {
  assertEquals(
    [100, 90, 89, 75, 74, 60, 59, 40, 39, -5, Number.NaN].map(
      gradeForPercentage,
    ),
    ["A", "A", "B", "B", "C", "C", "D", "D", "F", "F", "F"],
  );
});

Deno.test("gradeForPercentage: a fraction below a threshold takes the lower grade", () => {
  assertEquals(
    [89.99, 90, 75, 74.99, 60, 59.99, 40, 39.99, 150].map(gradeForPercentage),
    ["B", "A", "B", "C", "C", "D", "D", "F", "A"],
  );
});

Deno.test("percentageIfProvisionalEarned: adds the provisional points to the earned ones", () => {
  assertEquals(
    percentageIfProvisionalEarned({
      earnedPoints: 13,
      maxPoints: 16,
      provisionalPoints: 2,
    }),
    93,
  );
  assertEquals(
    percentageIfProvisionalEarned({
      earnedPoints: 13,
      maxPoints: 16,
      provisionalPoints: 0,
    }),
    81,
  );
  assertEquals(
    percentageIfProvisionalEarned({
      earnedPoints: 0,
      maxPoints: 0,
      provisionalPoints: 0,
    }),
    0,
  );
});
