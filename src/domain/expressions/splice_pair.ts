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

import type { RunSensitiveValues } from "../secrets/mod.ts";
import type { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  replaceExpressions,
  type SpliceSanitizer,
} from "./expression_parser.ts";

/**
 * Whether a path in a definition's data holds an argument that reaches the
 * method: `globalArguments...` or `methods.<name>.arguments...`. Only these
 * are restored to raw values by `resolveDeep` before a method runs, so only
 * these may carry sentinels.
 */
export function isDefinitionArgumentPath(path: string): boolean {
  return path === "globalArguments" ||
    path.startsWith("globalArguments.") ||
    path.startsWith("globalArguments[") ||
    /^methods\.[^.[]+\.arguments(?:$|[.[])/.test(path);
}

/**
 * Builds the sanitizer that replaces recorded sensitive values inside spliced
 * results with data-origin sentinels from the step's bag, at the paths
 * `applies` accepts. Authored text around a splice is never examined.
 */
export function sensitiveSpliceSanitizer(
  sensitiveValues: RunSensitiveValues,
  bag: VaultSecretBag,
  applies: (path: string) => boolean = () => true,
): SpliceSanitizer {
  const secrets = () => sensitiveValues.list().map((entry) => entry.value);
  return {
    whole: (value, path) =>
      applies(path) ? bag.sentinelizeValues(value, secrets()) : value,
    embedded: (text, path) =>
      applies(path) ? bag.sentinelizeText(text, secrets()) : text,
  };
}

/**
 * The same data kept twice: `raw`, which CEL contexts, caches, reports and
 * coercion read, and `sanitized`, which executes and carries sentinels where
 * sensitive values were spliced. Every pass evaluates each expression once
 * and splices the result into both. Sanitizing only changes spliced results,
 * never the expressions left in place, so both copies always hold the same
 * unevaluated expressions and each is spliced by its own text lookup.
 */
export class SplicePair<T = unknown> {
  constructor(readonly raw: T, readonly sanitized: T) {}

  /** A pair whose copies start identical. */
  static of<T>(data: T): SplicePair<T> {
    return new SplicePair(data, data);
  }

  /** Splices evaluated values into both copies. */
  splice(
    values: Map<string, unknown>,
    sanitizer: SpliceSanitizer,
    skipPath?: (path: string) => boolean,
  ): SplicePair<T> {
    return new SplicePair(
      replaceExpressions(this.raw, values, skipPath) as T,
      replaceExpressions(this.sanitized, values, skipPath, sanitizer) as T,
    );
  }

  /** Applies the same transformation to both copies. */
  map<U>(fn: (data: T, member: "raw" | "sanitized") => U): SplicePair<U> {
    return new SplicePair(fn(this.raw, "raw"), fn(this.sanitized, "sanitized"));
  }
}
