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
  SWAMP_OWNED_DIR_NAMES,
} from "../datastore/datastore_config.ts";
import { wordedError, wordedText } from "../behavior_wording.ts";

export type Namespace = string & { readonly _brand: unique symbol };

const NAMESPACE_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const NAMESPACE_MAX_LENGTH = 64;

/**
 * a namespace named after a layout directory shares it with the solo layout,
 * and a v3 checkout writes it at .swamp/<namespace>/ over swamp's own files;
 * built from SWAMP_OWNED_DIR_NAMES
 */
export const RESERVED_NAMESPACE_NAMES: ReadonlySet<string> = new Set<string>(
  SWAMP_OWNED_DIR_NAMES,
);

export function isReservedNamespaceName(slug: string): boolean {
  return RESERVED_NAMESPACE_NAMES.has(slug);
}

/**
 * only these share a directory with the solo layout on v2; a v2 repo already
 * bound to another reserved name keeps working, the wider set applies to new
 * claims and v3
 */
const LAYOUT_NAMESPACE_NAMES: ReadonlySet<string> = new Set<string>([
  ...DEFAULT_DATASTORE_SUBDIRS,
  ...ALWAYS_LOCAL_SUBDIRS,
]);

export function namespaceCollidesWithLayout(
  slug: string,
  datastoreDirectories: Iterable<string>,
): boolean {
  if (LAYOUT_NAMESPACE_NAMES.has(slug)) return true;
  for (const dir of datastoreDirectories) {
    if (dir === slug) return true;
  }
  return false;
}

export function namespaceNameClash(namespace: string): string {
  return `Namespace ${
    JSON.stringify(namespace)
  } has the same name as a datastore layout directory or a directory swamp keeps in .swamp/`;
}

/**
 * namespace set and datastore setup both refuse on v3, so the datastore config
 * is edited by hand and pointed at a new, empty v3 datastore
 */
export function reservedV3NamespaceMessage(namespace: string): string {
  return `${namespaceNameClash(namespace)}. A v3 checkout keeps namespace ` +
    `${JSON.stringify(namespace)}'s records in .swamp/${namespace}/, over ` +
    `swamp's own files, so it does not open on this namespace. Nothing was ` +
    `changed.\n\n` +
    `A v3 repository cannot change its namespace in place. To go on:\n` +
    `  1. Set up a new, empty v3 datastore, for example from a new ` +
    `repository with 'swamp datastore setup filesystem --path <dir> ` +
    `--format 3'\n` +
    `  2. In this repository's .swamp.yaml, set the datastore's ` +
    `\`namespace\` to a name that is not reserved and point the datastore ` +
    `at the new one\n` +
    `Nothing is migrated: the records committed under ` +
    `${JSON.stringify(namespace)} stay in the current datastore.`;
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

export function createNamespace(slug: string): Namespace {
  assertNamespaceShape(slug);
  if (isReservedNamespaceName(slug)) {
    throw new Error(
      `Namespace ${
        JSON.stringify(slug)
      } is reserved: it is a directory of the datastore layout or of swamp's .swamp/ directory`,
    );
  }
  return slug as Namespace;
}

/**
 * accepts a reserved name, so a repo bound to one before it was reserved still
 * loads
 */
export function restoreNamespace(slug: string): Namespace {
  assertNamespaceShape(slug);
  return slug as Namespace;
}

export const SOLO_NAMESPACE: Namespace = "" as Namespace;

export function isEmptyNamespace(ns: Namespace): boolean {
  return ns === "";
}

export interface NamespaceReader {
  readonly namespace: string;
  readonly readsSoloNamespace: boolean;
}

/**
 * a solo row in a namespaced repository predates the namespace and is the
 * reader's own, unless the reader reads solo as another namespace; a catalog
 * pull never stores a solo row
 */
export function isForeignToReader(
  namespace: string,
  reader: NamespaceReader,
): boolean {
  if (namespace === reader.namespace) return false;
  return namespace !== "" || reader.readsSoloNamespace;
}

export interface NamespacedModelName {
  readonly namespace: string | undefined;
  readonly modelName: string;
}

export function parseNamespacedModelName(input: string): NamespacedModelName {
  if (input === "") {
    throw wordedError(
      wordedText((w) => `Invalid namespaced ${w.noun} name: input is empty`),
    );
  }

  const colonIndex = input.indexOf(":");
  if (colonIndex === -1) {
    return { namespace: undefined, modelName: input };
  }

  const namespace = input.slice(0, colonIndex);
  const modelName = input.slice(colonIndex + 1);

  if (modelName === "") {
    throw wordedError(
      wordedText((w) =>
        `Invalid namespaced ${w.noun} name: ${w.noun} name is empty in ${
          JSON.stringify(input)
        }`
      ),
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
