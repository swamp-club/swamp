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

import type { SafetyIssue } from "./extension_safety_analyzer.ts";

/**
 * Thrown when a bundle built on this machine holds a safety error, before
 * the bundle is imported (swamp-club#3383). Whoever installs the bundle
 * catches it, undoes the install, and tells the user.
 */
export class BundleSafetyRefusal extends Error {
  /** The errors, each naming the bundle and the module. */
  readonly errors: readonly SafetyIssue[];
  /** Refused bundles that could not be deleted from disk. */
  readonly leftBehind: readonly string[];

  constructor(
    errors: readonly SafetyIssue[],
    leftBehind: readonly string[] = [],
  ) {
    super(
      `Bundle has safety errors:\n${
        errors.map((e) => `  ${e.file}: ${e.message}`).join("\n")
      }`,
    );
    this.name = "BundleSafetyRefusal";
    this.errors = errors;
    this.leftBehind = leftBehind;
  }

  /** One refusal carrying the errors and left-behind bundles of all. */
  static merge(refusals: readonly BundleSafetyRefusal[]): BundleSafetyRefusal {
    return new BundleSafetyRefusal(
      refusals.flatMap((r) => r.errors),
      refusals.flatMap((r) => r.leftBehind),
    );
  }
}
