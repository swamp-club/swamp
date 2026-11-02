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

import { secretOccurrencesOf } from "../vaults/secret_occurrences.ts";
import { SECRET_OPERATION_UNSUPPORTED, SecretRefusedError } from "./errors.ts";
import type { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  replaceExpressions,
  replaceExpressionsTracked,
  type SpliceOrigin,
  type SpliceSanitizer,
} from "./expression_parser.ts";
import { keyPath, ProvenanceMap, sentinelStandInOf } from "./provenance_map.ts";

/**
 * only these paths are restored to raw values by resolveDeep before a method
 * runs, so only they may carry sentinels
 */
export function isDefinitionArgumentPath(path: string): boolean {
  return path === "globalArguments" ||
    path.startsWith("globalArguments.") ||
    path.startsWith("globalArguments[") ||
    /^methods\.[^.[]+\.arguments(?:$|[.[])/.test(path);
}

/**
 * a delivery resolves, checks and fails on runtime expressions at these paths
 * only; another method's reference is no more this delivery's to read than its
 * inputs are
 */
export function isDeliveredWithMethod(
  path: string,
  methodName: string,
): boolean {
  const methods = keyPath("", "methods");
  return !isUnder(path, methods) ||
    isUnder(path, keyPath(methods, methodName));
}

/**
 * a runtime pass scoped to a method neither resolves nor substitutes into
 * another method's subtree, so a raw text shared with the delivered method
 * keeps its authored form there
 */
export function isOutsideMethodDelivery(
  path: string,
  methodName: string,
): boolean {
  return path !== keyPath("", "methods") &&
    !isDeliveredWithMethod(path, methodName);
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + ".") ||
    path.startsWith(root + "[");
}

export function sensitiveSpliceSanitizer(
  bag: VaultSecretBag,
): SpliceSanitizer {
  const secrets = secretOccurrencesOf(bag.registry);
  return {
    whole: (value) => value,
    embedded: (text, path, value) => {
      if (
        value !== null && typeof value === "object" &&
        secrets.occurrencesIn(text).length > 0
      ) {
        throw new SecretRefusedError(
          SECRET_OPERATION_UNSUPPORTED,
          "interpolating a container holding a secret into text",
          path || "template",
        );
      }
      return text;
    },
    resolve: sentinelStandInOf(bag.registry),
  };
}

/**
 * typed evaluation puts reference sentinels in both copies, but identifier
 * substitutions and pre-existing bases can still differ; each expression is
 * evaluated once and spliced into both
 */
export class SplicePair<T = unknown> {
  constructor(
    readonly raw: T,
    readonly sanitized: T,
    readonly rawProvenance: ProvenanceMap = ProvenanceMap.authored(),
    /**
     * Where data sits in `sanitized`. Kept separately because sentinels
     * change the length of sanitized text.
     */
    readonly sanitizedProvenance: ProvenanceMap = rawProvenance,
  ) {}

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

  withProvenance(
    raw: ProvenanceMap,
    sanitized: ProvenanceMap = raw,
  ): SplicePair<T> {
    return new SplicePair(this.raw, this.sanitized, raw, sanitized);
  }
}
