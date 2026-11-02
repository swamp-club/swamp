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
 * a data save carries content a run produced; serve acts on its vault
 * references beyond storing it. A removal or rename needs only write, so it may
 * only move or lower what the repository wrote.
 */

import type { ContentRefusal } from "../domain/datastore_v3/commit_authorization.ts";
import type { Op, PutOp } from "../domain/datastore_v3/op.ts";
import {
  type DataMetadata,
  DataMetadataSchema,
} from "../domain/data/data_metadata.ts";
import {
  parseSensitiveFieldsTag,
  sanitizeVaultKey,
  sensitiveVaultReferences,
} from "../domain/models/data_writer.ts";
import {
  isCallerVaultAuthorized,
  vaultAccessResource,
} from "./handlers/shared.ts";
import { canonicalJson } from "../domain/expressions/expression_references.ts";
import {
  type ContentCheckContext,
  parseRecord,
  refused,
} from "./forwarded_content_authorization.ts";

interface DataKey {
  readonly base: string;
  readonly name: string;
  readonly version?: number;
  readonly file: "raw" | "metadata.yaml" | "latest";
}

function dataKeyOf(key: string): DataKey | undefined {
  const segments = key.split("/");
  const last = segments[segments.length - 1];
  if (last === "latest") {
    return {
      base: segments.slice(0, -2).join("/"),
      name: segments[segments.length - 2],
      file: "latest",
    };
  }
  if (last !== "raw" && last !== "metadata.yaml") return undefined;
  const version = Number(segments[segments.length - 2]);
  if (!Number.isSafeInteger(version)) return undefined;
  return {
    base: segments.slice(0, -3).join("/"),
    name: segments[segments.length - 3],
    version,
    file: last,
  };
}

function keyOf(base: string, name: string, tail: string): string {
  return `${base}/${name}/${tail}`;
}

export async function checkDataPut(
  context: ContentCheckContext,
  op: PutOp,
  commit: readonly Op[],
): Promise<ContentRefusal | undefined> {
  const key = dataKeyOf(op.key.toString());
  if (key === undefined) return refused(op, "it is not a data record");
  switch (op.intent.kind) {
    case "data.save":
    case "data.append":
      return await sensitiveReferenceRefusal(context, op, key, commit);
    case "data.delete":
    case "data.gc":
      return await markerRefusal(context, op, key, commit);
    case "data.rename":
      return await renameRefusal(context, op, key, commit);
  }
  return refused(op, "it is not a data write");
}

async function bytesAt(
  context: ContentCheckContext,
  commit: readonly Op[],
  key: string,
): Promise<Uint8Array | ContentRefusal | undefined> {
  const put = commit.find((other): other is PutOp =>
    other.kind === "put" && other.key.toString() === key
  );
  if (put !== undefined) return await context.bytesOf(put);
  const prior = await context.prior(context.deps.partition, key);
  if (prior.kind === "unreadable") {
    return { message: `${key} cannot be read` };
  }
  return prior.kind === "present" ? prior.bytes : undefined;
}

function metadataOf(bytes: Uint8Array): DataMetadata | undefined {
  const parsed = DataMetadataSchema.safeParse(parseRecord(bytes));
  return parsed.success ? parsed.data : undefined;
}

/**
 * sensitive fields hold vault references admitted to later runs, so each must
 * be readable by the caller or writable under this behavior's derived key; any
 * other key could point a run at an unreadable secret
 */
async function sensitiveReferenceRefusal(
  context: ContentCheckContext,
  op: PutOp,
  key: DataKey,
  commit: readonly Op[],
): Promise<ContentRefusal | undefined> {
  const intent = op.intent;
  if (!("model" in intent) || key.version === undefined) return undefined;
  const version = `${key.version}`;
  const metadataBytes = await bytesAt(
    context,
    commit,
    keyOf(key.base, key.name, `${version}/metadata.yaml`),
  );
  if (metadataBytes === undefined) return undefined;
  if (!(metadataBytes instanceof Uint8Array)) return metadataBytes;
  const metadata = metadataOf(metadataBytes);
  if (metadata === undefined) {
    return refused(op, "its metadata is not data metadata");
  }
  const fields = parseSensitiveFieldsTag(metadata.tags);
  if (fields === null) return undefined;
  const raw = await bytesAt(
    context,
    commit,
    keyOf(key.base, key.name, `${version}/raw`),
  );
  if (raw === undefined) return undefined;
  if (!(raw instanceof Uint8Array)) return raw;
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    // not JSON: serve admits no reference from it
    return undefined;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const own = sanitizeVaultKey(`${intent.model.type}/${intent.model.id}/`);
  const { caller, requestId, ctx } = context.deps;
  const allowed = (
    vaultName: string,
    action: "read" | "write",
    secretKey: string,
  ) =>
    isCallerVaultAuthorized(caller, requestId, {
      vaultName,
      action,
      existing: vaultAccessResource(vaultName),
      key: secretKey,
    }, ctx);
  for (
    const { vaultName, key: secretKey } of sensitiveVaultReferences(
      data as Record<string, unknown>,
      fields,
    )
  ) {
    if (allowed(vaultName, "read", secretKey)) continue;
    if (secretKey.startsWith(own) && allowed(vaultName, "write", secretKey)) {
      continue;
    }
    return refused(
      op,
      `a sensitive field names a secret in vault:${vaultName} the caller may not read`,
    );
  }
  return undefined;
}

function markerVersion(bytes: Uint8Array): number | undefined {
  const text = new TextDecoder().decode(bytes);
  return /^[1-9][0-9]*$/.test(text) ? Number(text) : undefined;
}

/**
 * a removal's put may only lower or keep a name's latest marker, to a stored
 * version the commit does not remove: the repository's own marker after a
 * removal
 */
async function markerRefusal(
  context: ContentCheckContext,
  op: PutOp,
  key: DataKey,
  commit: readonly Op[],
): Promise<ContentRefusal | undefined> {
  if (key.file !== "latest") {
    return refused(op, "a data removal may only write a latest marker");
  }
  const bytes = await context.bytesOf(op);
  if (!(bytes instanceof Uint8Array)) return bytes;
  const version = markerVersion(bytes);
  if (version === undefined) {
    return refused(op, "its latest marker is not a version");
  }
  const current = await context.prior(
    context.deps.partition,
    keyOf(key.base, key.name, "latest"),
  );
  const currentVersion = current.kind === "present"
    ? markerVersion(current.bytes)
    : undefined;
  if (currentVersion === undefined || version > currentVersion) {
    return refused(op, "a data removal may not raise a latest marker");
  }
  const metadata = keyOf(key.base, key.name, `${version}/metadata.yaml`);
  const removed = commit.some((other) =>
    other.kind === "tombstone" && other.key.toString() === metadata
  );
  const stored = await context.prior(context.deps.partition, metadata);
  return !removed && stored.kind === "present"
    ? undefined
    : refused(op, "its latest marker names a version that is not stored");
}

function carried(metadata: DataMetadata): string {
  return canonicalJson({
    lifetime: metadata.lifetime,
    garbageCollection: metadata.garbageCollection,
    tags: metadata.tags,
    ownerDefinition: metadata.ownerDefinition,
  });
}

/**
 * a rename moves the latest version of a name as the data repository writes it:
 * new name gets content and metadata, old name a rename marker version, each
 * latest marker names the written version; nothing else
 */
async function renameRefusal(
  context: ContentCheckContext,
  op: PutOp,
  key: DataKey,
  commit: readonly Op[],
): Promise<ContentRefusal | undefined> {
  const intent = op.intent;
  if (intent.kind !== "data.rename") return refused(op, "it is not a rename");
  const from = intent.name;
  const to = intent.to;
  const partition = context.deps.partition;
  const marker = await context.prior(
    partition,
    keyOf(key.base, from, "latest"),
  );
  if (marker.kind !== "present") {
    return refused(op, "the name it renames has no stored version");
  }
  const sourceVersion = markerVersion(marker.bytes);
  if (sourceVersion === undefined) {
    return refused(op, "the name it renames has no stored version");
  }
  const sourceMetadataRecord = await context.prior(
    partition,
    keyOf(key.base, from, `${sourceVersion}/metadata.yaml`),
  );
  const source = sourceMetadataRecord.kind === "present"
    ? metadataOf(sourceMetadataRecord.bytes)
    : undefined;
  if (source === undefined) {
    return refused(op, "the version it renames cannot be read");
  }
  const written = (name: string) =>
    new Set(
      commit.flatMap((other) => {
        if (other.kind !== "put") return [];
        const parsed = dataKeyOf(other.key.toString());
        return parsed?.name === name && parsed.version !== undefined &&
            parsed.file === "metadata.yaml"
          ? [parsed.version]
          : [];
      }),
    );

  if (key.file === "latest") {
    const bytes = await context.bytesOf(op);
    if (!(bytes instanceof Uint8Array)) return bytes;
    const version = markerVersion(bytes);
    return version !== undefined && written(key.name).has(version)
      ? undefined
      : refused(
        op,
        "its latest marker names a version the rename does not write",
      );
  }
  if (key.name === to && key.file === "raw") {
    const digest = await context.digest(
      partition,
      keyOf(key.base, from, `${sourceVersion}/raw`),
    );
    return digest === op.sha256
      ? undefined
      : refused(op, "the renamed content is not the content it renames");
  }
  const bytes = await context.bytesOf(op);
  if (!(bytes instanceof Uint8Array)) return bytes;
  if (key.name === to) {
    const metadata = metadataOf(bytes);
    return metadata !== undefined && metadata.name === to &&
        metadata.contentType === source.contentType &&
        metadata.streaming === source.streaming &&
        metadata.lifecycle === undefined &&
        metadata.renamedTo === undefined &&
        carried(metadata) === carried(source)
      ? undefined
      : refused(op, "the renamed metadata is not the metadata it renames");
  }
  if (key.file === "raw") {
    let marker: unknown;
    try {
      marker = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return refused(op, "its rename marker is not a rename marker");
    }
    const fields = marker !== null && typeof marker === "object"
      ? Object.keys(marker).sort().join(",")
      : "";
    const { renamedTo, renamedAt } = marker as Record<string, unknown>;
    return fields === "renamedAt,renamedTo" && renamedTo === to &&
        typeof renamedAt === "string" && !Number.isNaN(Date.parse(renamedAt))
      ? undefined
      : refused(op, "its rename marker is not a rename marker");
  }
  const metadata = metadataOf(bytes);
  return metadata !== undefined && metadata.id === source.id &&
      metadata.name === from && metadata.lifecycle === "deleted" &&
      metadata.renamedTo === to && metadata.streaming === false &&
      metadata.contentType === "application/json" &&
      carried(metadata) === carried(source)
    ? undefined
    : refused(op, "its rename marker is not the version it renames, marked");
}
