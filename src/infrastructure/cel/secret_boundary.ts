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

/**
 * The boundary conversion of the CEL adapter
 * (design/enablers/typed-secrets.md Section 3.2). Outside CEL a secret is a
 * sentinel in text; inside CEL it is a `Secret`.
 *
 * - Bindings: a string bound into CEL that holds sentinels the run's
 *   registry issued becomes a `Secret`. Text with any other prefix stays
 *   text. Containers are read through views: new objects whose properties
 *   are getters over the original, so the original is never wrapped or
 *   mutated, and none of its getters fires unless CEL reads that key (the
 *   lazy `model.*.resource` loaders stay lazy). A read that yields a `Secret`
 *   counts toward the container rule (Section 4.3 item 5).
 * - Results: a `Secret` becomes its sentinel, issued into the run's
 *   registry, and a composition becomes its text with a sentinel for each
 *   reference. Views become new plain objects. This runs before the
 *   adapter's own post-processing, after recording stops.
 *
 * No `Secret` and no view leaves the adapter.
 */

import { Optional } from "cel-js";
import {
  SECRET_DESTINATION_REFUSED,
  SecretRefusedError,
} from "../../domain/expressions/errors.ts";
import type { SecretBagRegistry } from "../../domain/vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import {
  recordBoundaryFailure,
  recordSecretRead,
  refuse,
} from "./secret_fault_context.ts";
import {
  isSecret,
  type Secret,
  secretFromParts,
  type SecretPart,
  secretParts,
  type SecretReferencePart,
} from "./secret_value.ts";

/** The prefix every sentinel starts with, checked before a full scan. */
const SENTINEL_MARK = "__SWAMP_VSEC_";

/**
 * Whether cel-js reads `value` as a map: an object whose prototype is
 * `Object.prototype` or `null`. A `Secret`, a class instance, a `Map` or a
 * `Set` is not one.
 */
function isPlainMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function defineValue(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * The conversion for one evaluation: the run's bag to issue into, the views
 * built so far, and the sentinels issued so far.
 */
export class SecretBoundary {
  private readonly registry: SecretBagRegistry;
  /** Each viewed original's view, so aliased paths keep their identity. */
  private readonly views = new WeakMap<object, object>();
  /** Each reference part's issued sentinel, so a part is issued once. */
  private readonly issued = new WeakMap<SecretReferencePart, string>();

  constructor(
    /** The run's issuing bag: a delivery view cannot issue. */
    private readonly bag: VaultSecretBag,
  ) {
    this.registry = bag.registry;
  }

  /**
   * The bindings `context` with every sentinel the run issued read as a
   * `Secret`. The context itself is returned when the run issued none.
   */
  bind(context: Record<string, unknown>): Record<string, unknown> {
    if (this.registry.isEmpty) return context;
    return this.viewOfMap(context);
  }

  /**
   * `value` with every `Secret` turned into its sentinel text and every
   * container rebuilt as a plain one, ready for the adapter's
   * post-processing.
   */
  release(value: unknown): unknown {
    if (isSecret(value)) return this.sentinelText(value);
    if (value instanceof Optional) {
      return value.hasValue()
        ? Optional.of(this.release(value.value()))
        : value;
    }
    if (Array.isArray(value)) return value.map((item) => this.release(item));
    if (isPlainMap(value)) {
      const out: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(value)) {
        defineValue(out, key, this.release(value[key]));
      }
      return out;
    }
    return value;
  }

  private convert(value: unknown): unknown {
    if (typeof value === "string") return this.fromText(value);
    if (Array.isArray(value)) return this.viewOfList(value);
    if (isPlainMap(value)) return this.viewOfMap(value);
    return value;
  }

  private viewOfMap(
    original: Record<string, unknown>,
  ): Record<string, unknown> {
    const existing = this.views.get(original);
    if (existing !== undefined) return existing as Record<string, unknown>;
    const view: Record<string, unknown> = Object.create(
      Object.getPrototypeOf(original),
    );
    this.views.set(original, view);
    for (const key of Object.keys(original)) {
      this.defineConverting(view, key, () => original[key]);
    }
    return view;
  }

  private viewOfList(original: readonly unknown[]): object {
    const existing = this.views.get(original);
    if (existing !== undefined) return existing;
    const view: unknown[] = [];
    this.views.set(original, view);
    for (let index = 0; index < original.length; index++) {
      if (!(index in original)) continue;
      this.defineConverting(view, String(index), () => original[index]);
    }
    view.length = original.length;
    return view;
  }

  /**
   * A getter that reads the original once, converts what it read, and
   * counts every read that yields a `Secret`.
   */
  private defineConverting(
    view: object,
    key: string,
    read: () => unknown,
  ): void {
    let converted: unknown;
    let done = false;
    Object.defineProperty(view, key, {
      enumerable: true,
      configurable: false,
      get: () => {
        if (!done) {
          converted = this.convert(read());
          done = true;
        }
        if (isSecret(converted)) recordSecretRead();
        return converted;
      },
    });
  }

  /**
   * `text` as a `Secret` when it holds a sentinel the run issued: an exact
   * sentinel is one reference, mixed text a composition. Text that holds no
   * sentinel of the run stays text.
   */
  private fromText(text: string): string | Secret {
    if (!text.includes(SENTINEL_MARK)) return text;
    const parts: SecretPart[] = [];
    let last = 0;
    for (const match of text.matchAll(VaultSecretBag.SENTINEL_PATTERN)) {
      const sentinel = match[0];
      if (!this.registry.drewPrefixOf(sentinel)) continue;
      const entry = this.registry.issuedEntryOf(sentinel);
      if (entry === undefined) {
        const error = new Error(
          "A binding holds a sentinel with this run's prefix that names no secret the run issued",
        );
        recordBoundaryFailure(error);
        throw error;
      }
      parts.push(text.slice(last, match.index));
      parts.push({
        reference: entry.reference,
        dataOrigin: entry.dataOrigin,
        location: "location" in entry ? entry.location : undefined,
        sentinel,
      });
      last = match.index + sentinel.length;
    }
    if (parts.length === 0) return text;
    parts.push(text.slice(last));
    return secretFromParts(parts);
  }

  private sentinelText(secret: Secret): string {
    return (secretParts(secret) ?? [])
      .map((part) => typeof part === "string" ? part : this.sentinelOf(part))
      .join("");
  }

  private sentinelOf(part: SecretReferencePart): string {
    if (part.sentinel !== undefined) return part.sentinel;
    let sentinel = this.issued.get(part);
    if (sentinel === undefined) {
      if (part.dataOrigin || part.location === undefined) {
        // The accessor adapter (typed-secrets 3.3) issues these; until then
        // nothing makes one, and it must not leave CEL without a sentinel.
        throw new Error(
          "A secret read from data has no sentinel to leave the expression as",
        );
      }
      sentinel = this.bag.addSecret(part.reference, part.location);
      this.issued.set(part, sentinel);
    }
    return sentinel;
  }
}

/**
 * Refuse a `Secret` in a result that has no run's bag to issue into, which
 * is a destination that cannot hold one.
 */
export function refuseUnboundSecrets(value: unknown, expression: string): void {
  if (containsSecret(value)) {
    throw new SecretRefusedError(
      SECRET_DESTINATION_REFUSED,
      "a secret result with no run to issue its sentinel",
      expression,
    );
  }
}

function containsSecret(value: unknown): boolean {
  if (isSecret(value)) return true;
  if (value instanceof Optional) {
    return value.hasValue() && containsSecret(value.value());
  }
  if (Array.isArray(value)) return value.some(containsSecret);
  if (isPlainMap(value)) {
    return Object.keys(value).some((key) => containsSecret(value[key]));
  }
  return false;
}

/**
 * `value` for a destination that takes no secret: a plain copy with every
 * view and container rebuilt, after refusing any `Secret` in it, at any
 * depth, with `secret_destination_refused`, recorded first. Containers keep
 * their prototype, so the destination sees the shape it sees today.
 */
export function detachForDestination(
  value: unknown,
  operation: string,
): unknown {
  if (isSecret(value)) return refuse(operation, SECRET_DESTINATION_REFUSED);
  if (value instanceof Optional) {
    return value.hasValue()
      ? Optional.of(detachForDestination(value.value(), operation))
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => detachForDestination(item, operation));
  }
  if (value instanceof Map) {
    return new Map(
      [...value].map((
        [key, item],
      ) => [key, detachForDestination(item, operation)]),
    );
  }
  if (isPlainMap(value)) {
    const out: Record<string, unknown> = Object.create(
      Object.getPrototypeOf(value),
    );
    for (const key of Object.keys(value)) {
      defineValue(out, key, detachForDestination(value[key], operation));
    }
    return out;
  }
  return value;
}
