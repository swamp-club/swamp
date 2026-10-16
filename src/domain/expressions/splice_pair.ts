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
  replaceExpressionsTracked,
  type SpliceOrigin,
  type SpliceSanitizer,
} from "./expression_parser.ts";
import { ProvenanceMap, sentinelResolverOf } from "./provenance_map.ts";

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
  return {
    whole: (value, path) =>
      applies(path)
        ? bag.sentinelizeValues(value, sensitiveValues.list())
        : value,
    embedded: (text, path) =>
      applies(path) ? bag.sentinelizeText(text, sensitiveValues.list()) : text,
    resolve: sentinelResolverOf(bag),
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
  constructor(
    readonly raw: T,
    readonly sanitized: T,
    /** Where data sits in `raw` (swamp-club#3205). */
    readonly rawProvenance: ProvenanceMap = ProvenanceMap.authored(),
    /**
     * Where data sits in `sanitized`. Kept separately because sentinels
     * change the length of sanitized text.
     */
    readonly sanitizedProvenance: ProvenanceMap = rawProvenance,
  ) {}

  /** A pair whose copies start identical. */
  static of<T>(
    data: T,
    provenance: ProvenanceMap = ProvenanceMap.authored(),
  ): SplicePair<T> {
    return new SplicePair(data, data, provenance, provenance);
  }

  /**
   * Splices evaluated values into both copies. An occurrence overlapping data
   * in a copy's map is left in place; `originOf` says where each spliced
   * value came from, so the maps record the data each splice adds.
   */
  splice(
    values: Map<string, unknown>,
    sanitizer: SpliceSanitizer,
    skipPath?: (path: string) => boolean,
    originOf?: (raw: string) => SpliceOrigin,
  ): SplicePair<T> {
    if (
      !originOf && this.rawProvenance.isAuthored &&
      this.sanitizedProvenance.isAuthored
    ) {
      return new SplicePair(
        replaceExpressions(this.raw, values, skipPath) as T,
        replaceExpressions(this.sanitized, values, skipPath, sanitizer) as T,
      );
    }
    const origin = originOf ?? (() => ({ map: ProvenanceMap.data() }));
    const raw = replaceExpressionsTracked(
      this.raw,
      values,
      this.rawProvenance,
      origin,
      skipPath,
    );
    const sanitized = replaceExpressionsTracked(
      this.sanitized,
      values,
      this.sanitizedProvenance,
      origin,
      skipPath,
      sanitizer,
    );
    return new SplicePair(
      raw.data as T,
      sanitized.data as T,
      raw.provenance,
      sanitized.provenance,
    );
  }

  /**
   * Applies the same transformation to both copies. The maps are kept
   * unchanged, so `fn` must not move values between paths; use
   * {@link withProvenance} to set maps for a reshaped pair.
   */
  map<U>(fn: (data: T, member: "raw" | "sanitized") => U): SplicePair<U> {
    return new SplicePair(
      fn(this.raw, "raw"),
      fn(this.sanitized, "sanitized"),
      this.rawProvenance,
      this.sanitizedProvenance,
    );
  }

  /** This pair with new maps for its copies. */
  withProvenance(
    raw: ProvenanceMap,
    sanitized: ProvenanceMap = raw,
  ): SplicePair<T> {
    return new SplicePair(this.raw, this.sanitized, raw, sanitized);
  }
}
