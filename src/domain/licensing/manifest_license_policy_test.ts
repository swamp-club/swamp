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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkManifestLicense,
  isValidManifestLicense,
  type ManifestLicenseViolation,
  manifestLicenseWarning,
} from "./manifest_license_policy.ts";

function violations(license: string): ManifestLicenseViolation[] {
  const result = checkManifestLicense(license);
  assert(!result.valid, `expected "${license}" to be invalid`);
  return result.violations;
}

for (
  const license of [
    "MIT",
    "Apache-2.0",
    "MIT OR Apache-2.0",
    "(MIT OR Apache-2.0) AND BSD-3-Clause",
    "GPL-2.0-only WITH Classpath-exception-2.0",
    "AGPL-3.0-or-later",
  ]
) {
  Deno.test(`checkManifestLicense: accepts ${license}`, () => {
    assertEquals(checkManifestLicense(license).valid, true);
    assertEquals(isValidManifestLicense(license), true);
  });
}

Deno.test("checkManifestLicense: invalid syntax names the token", () => {
  const [v] = violations("MIT Apache-2.0");
  assertEquals(v.reason, "invalid-syntax");
  assertEquals(v.term, "Apache-2.0");
});

Deno.test("checkManifestLicense: an id not on the SPDX list is unknown", () => {
  const [v] = violations("MIT OR Swampy-1.0");
  assertEquals(v.reason, "unknown-license");
  assertEquals(v.term, "Swampy-1.0");
});

Deno.test("checkManifestLicense: wrong case gets a did-you-mean", () => {
  const [v] = violations("apache-2.0");
  assertEquals(v.reason, "unknown-license");
  assertStringIncludes(v.message, "did you mean Apache-2.0?");
});

Deno.test("checkManifestLicense: a deprecated id is invalid, with its replacement", () => {
  const [v] = violations("AGPL-3.0");
  assertEquals(v.reason, "deprecated-license");
  assertStringIncludes(v.message, "did you mean AGPL-3.0-only?");
});

Deno.test("checkManifestLicense: a deprecated + id suggests -or-later", () => {
  const [v] = violations("GPL-2.0+");
  assertEquals(v.reason, "deprecated-license");
  assertEquals(v.term, "GPL-2.0+");
  assertStringIncludes(v.message, "did you mean GPL-2.0-or-later?");
});

Deno.test("checkManifestLicense: + on a license with no -or-later has no hint", () => {
  const [v] = violations("MIT+");
  assertEquals(v.reason, "deprecated-license");
  assertEquals(v.message.includes("did you mean"), false);
});

Deno.test("checkManifestLicense: an unknown exception is invalid", () => {
  const [v] = violations("GPL-2.0-only WITH Swamp-exception");
  assertEquals(v.reason, "unknown-exception");
  assertEquals(v.term, "Swamp-exception");
});

Deno.test("checkManifestLicense: a lowercase operator is invalid syntax naming the uppercase form", () => {
  const [v] = violations("MIT or Apache-2.0");
  assertEquals(v.reason, "invalid-syntax");
  assertEquals(v.term, "or");
  assertStringIncludes(v.message, "must be written in uppercase: OR");
});

Deno.test("checkManifestLicense: an SPDX exception in the wrong case gets a did-you-mean", () => {
  const [v] = violations("GPL-2.0-only WITH classpath-exception-2.0");
  assertEquals(v.reason, "unknown-exception");
  assertStringIncludes(v.message, "did you mean Classpath-exception-2.0?");
});

for (
  const [license, term] of [
    ["LicenseRef-Proprietary", "LicenseRef-Proprietary"],
    ["MIT OR LicenseRef-Mine", "LicenseRef-Mine"],
    ["DocumentRef-x:LicenseRef-y", "DocumentRef-x:LicenseRef-y"],
    ["AGPL-3.0-only WITH AdditionRef-Other", "AdditionRef-Other"],
    [
      "AGPL-3.0-only WITH AdditionRef-Swamp-Extension-Exception",
      "AdditionRef-Swamp-Extension-Exception",
    ],
    [
      "AGPL-3.0-or-later WITH AdditionRef-Swamp-Extension-Exception",
      "AdditionRef-Swamp-Extension-Exception",
    ],
  ] as const
) {
  Deno.test(`checkManifestLicense: the custom reference in ${license} is not SPDX`, () => {
    const [v] = violations(license);
    assertEquals(v.reason, "custom-ref");
    assertEquals(v.term, term);
  });
}

Deno.test("checkManifestLicense: reports every bad term", () => {
  assertEquals(
    violations("Nope-1 AND LicenseRef-x").map((v) => v.reason),
    ["unknown-license", "custom-ref"],
  );
});

Deno.test("isValidManifestLicense: undefined is not valid", () => {
  assertEquals(isValidManifestLicense(undefined), false);
});

Deno.test("manifestLicenseWarning: none for a valid or undeclared license", () => {
  assertEquals(manifestLicenseWarning(undefined), undefined);
  assertEquals(manifestLicenseWarning("MIT OR Apache-2.0"), undefined);
});

Deno.test("manifestLicenseWarning: an invalid license warns with every violation", () => {
  const warning = manifestLicenseWarning("Nope-1 OR LicenseRef-x");
  assertEquals(warning?.license, "Nope-1 OR LicenseRef-x");
  assertEquals(warning?.reason, "unknown-license");
  assertEquals(warning?.term, "Nope-1");
  assertEquals(warning?.violations.map((v) => v.reason), [
    "unknown-license",
    "custom-ref",
  ]);
  assertStringIncludes(
    warning?.message ?? "",
    'License "Nope-1 OR LicenseRef-x" in manifest.yaml is not a valid SPDX expression, so it earns no quality points',
  );
});
