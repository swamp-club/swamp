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

import {
  ALWAYS_LOCAL_SUBDIRS,
  DEFAULT_DATASTORE_SUBDIRS,
} from "../datastore/datastore_config.ts";

export type Namespace = string & { readonly _brand: unique symbol };

const NAMESPACE_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const NAMESPACE_MAX_LENGTH = 64;

/**
 * Names a namespace cannot take because the datastore layout already uses
 * them as directories. A namespace is the outermost segment of the datastore
 * tier (`{base}/{namespace}/{subdir}/...`), so one named after a layout
 * directory shares a directory with the solo layout (`{base}/{subdir}/...`).
 * Derived from the layout constants so a directory added later is reserved
 * with it.
 */
export const RESERVED_NAMESPACE_NAMES: ReadonlySet<string> = new Set<string>([
  ...DEFAULT_DATASTORE_SUBDIRS,
  ...ALWAYS_LOCAL_SUBDIRS,
]);

export function isReservedNamespaceName(slug: string): boolean {
  return RESERVED_NAMESPACE_NAMES.has(slug);
}

/**
 * True when a namespace slug names a directory of the datastore layout:
 * a reserved name, or one of the repo's configured datastore directories.
 */
export function namespaceCollidesWithLayout(
  slug: string,
  datastoreDirectories: Iterable<string>,
): boolean {
  if (isReservedNamespaceName(slug)) return true;
  for (const dir of datastoreDirectories) {
    if (dir === slug) return true;
  }
  return false;
}

function assertNamespaceShape(slug: string): void {
  if (slug.length === 0) {
    throw new Error("Namespace cannot be empty — use SOLO_NAMESPACE instead");
  }
  if (slug.length > NAMESPACE_MAX_LENGTH) {
    throw new Error(
      `Namespace must be at most ${NAMESPACE_MAX_LENGTH} characters, got ${slug.length}`,
    );
  }
  if (!NAMESPACE_PATTERN.test(slug)) {
    throw new Error(
      `Namespace must match [a-z0-9][a-z0-9-]*: ${JSON.stringify(slug)}`,
    );
  }
}

/**
 * Creates a namespace a repo is about to claim. Rejects reserved names.
 */
export function createNamespace(slug: string): Namespace {
  assertNamespaceShape(slug);
  if (isReservedNamespaceName(slug)) {
    throw new Error(
      `Namespace ${
        JSON.stringify(slug)
      } is reserved: it is a directory of the datastore layout`,
    );
  }
  return slug as Namespace;
}

/**
 * Rebuilds a namespace already stored in a repo's config. Unlike
 * {@link createNamespace} it accepts a reserved name, so a repo bound to one
 * before the name was reserved still loads.
 */
export function restoreNamespace(slug: string): Namespace {
  assertNamespaceShape(slug);
  return slug as Namespace;
}

export const SOLO_NAMESPACE: Namespace = "" as Namespace;

export function isEmptyNamespace(ns: Namespace): boolean {
  return ns === "";
}

export interface NamespacedModelName {
  readonly namespace: string | undefined;
  readonly modelName: string;
}

export function parseNamespacedModelName(input: string): NamespacedModelName {
  if (input === "") {
    throw new Error("Invalid namespaced model name: input is empty");
  }

  const colonIndex = input.indexOf(":");
  if (colonIndex === -1) {
    return { namespace: undefined, modelName: input };
  }

  const namespace = input.slice(0, colonIndex);
  const modelName = input.slice(colonIndex + 1);

  if (modelName === "") {
    throw new Error(
      `Invalid namespaced model name: model name is empty in ${
        JSON.stringify(input)
      }`,
    );
  }

  if (namespace === "") {
    return { namespace: undefined, modelName };
  }

  return { namespace, modelName };
}

export function formatNamespacedModelName(
  namespace: string | undefined,
  modelName: string,
): string {
  if (namespace === undefined || namespace === "") return modelName;
  return `${namespace}:${modelName}`;
}
