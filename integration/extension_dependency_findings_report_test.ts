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
import { checkDependencyTrust } from "../src/domain/extensions/extension_dependency_trust_checker.ts";
import {
  buildFindingsReport,
  renderFindingsReport,
} from "../src/presentation/renderers/extension_findings_report.ts";
import type { Logger } from "@logtape/logtape";

/**
 * A yanked JSR dependency, end to end through the audit and the findings
 * report that closes push, dry run and quality: the warning and the
 * summary's fix line both name the version to move to (swamp-club#3677).
 */

const META = {
  scope: "std",
  name: "assert",
  latest: "1.0.2",
  versions: {
    "0.225.0": { yanked: true },
    "0.225.1": { yanked: true },
    "0.225.3": {},
    "1.0.2": {},
  },
};

Deno.test("yanked dependency: the audit and the Unresolved warnings summary both name the version to move to", async () => {
  const result = await checkDependencyTrust(
    [{
      name: "@std/assert",
      version: "0.225.0",
      registry: "jsr",
      sourceFile: "model.ts",
    }],
    () =>
      Promise.resolve(
        new Response(JSON.stringify(META), {
          headers: { "content-type": "application/json" },
        }),
      ),
  );
  const [finding] = result.warnings;
  assertEquals(finding.cause, "jsr-yanked");
  assertEquals(finding.suggestedVersion, "0.225.3");
  assertEquals(
    finding.message,
    "version 0.225.0 was withdrawn (yanked) by its author on JSR. Newest version that isn't yanked: 0.225.3.",
  );

  const lines: string[] = [];
  const logger = { info: (m: string) => lines.push(m) } as unknown as Logger;
  renderFindingsReport(
    logger,
    buildFindingsReport({
      safetyWarnings: [],
      reviewWarnings: [],
      dependencyWarnings: result.warnings,
      acceptances: { accepted: [] },
      commentSites: {},
    }, "/ext"),
    { manifestDir: "/ext", display: (path) => path },
  );
  assertEquals(lines, [
    "Unresolved warnings:",
    `  jsr-yanked — (dependency): @std/assert: ${finding.message}`,
    "    fix: Pin jsr:@std/assert@0.225.3 (or the newest non-yanked version your code supports).",
  ]);
});
