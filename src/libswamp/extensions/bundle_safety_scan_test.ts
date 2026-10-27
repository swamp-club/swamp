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
import {
  bundleDependencyWarnings,
  describeBundleErrors,
} from "./bundle_safety_scan.ts";
import type { BundleDependencyIssue } from "../../domain/extensions/extension_safety_analyzer.ts";

function dependencyIssue(
  dependency: string,
  file: string,
): BundleDependencyIssue {
  return {
    dependency,
    issue: { ruleId: "dynamic-code", file, line: 1, message: "m" },
  };
}

Deno.test("bundleDependencyWarnings: one warning per dependency, naming its bundles", () => {
  assertEquals(
    bundleDependencyWarnings([
      dependencyIssue("npm:a/1.0.0/i.js", "bundles/x.js"),
      dependencyIssue("npm:b/2.0.0/i.js", "bundles/x.js"),
      dependencyIssue("npm:a/1.0.0/i.js", "bundles/y.js"),
      dependencyIssue("npm:a/1.0.0/i.js", "bundles/y.js"),
    ]),
    [
      {
        file: "npm:a/1.0.0/i.js",
        message: "Dependency code uses eval() or new Function(), in 2 " +
          "bundles. Findings in dependency code are reported, not refused.",
      },
      {
        file: "npm:b/2.0.0/i.js",
        message: "Dependency code uses eval() or new Function(), in " +
          "bundles/x.js. Findings in dependency code are reported, not refused.",
      },
    ],
  );
});

Deno.test("bundleDependencyWarnings: leaves out a dependency already reported", () => {
  assertEquals(
    bundleDependencyWarnings(
      [dependencyIssue("npm:a/1.0.0/i.js", "bundle rebuilt from models/m.ts")],
      new Set(["npm:a/1.0.0/i.js"]),
    ),
    [],
  );
});

Deno.test("describeBundleErrors: one line per error, with its line when it has one", () => {
  assertEquals(
    describeBundleErrors([
      { ruleId: "dynamic-code", file: "bundles/x.js", line: 3, message: "m1" },
      { ruleId: "dynamic-code", file: "bundles/y.js", message: "m2" },
    ]),
    "  bundles/x.js line 3: m1\n  bundles/y.js: m2",
  );
});
