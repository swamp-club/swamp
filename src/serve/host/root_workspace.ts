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

import { isAbsolute, join, resolve } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { atomicWriteTextFile } from "../../infrastructure/persistence/atomic_write.ts";
import {
  readCapped,
  removeIfPresent,
} from "../../infrastructure/persistence/hosted_workspace_file_repository.ts";
import type { HostedRegistryDeps } from "../../libswamp/workspace/hosted_registration.ts";
import {
  folderRepoIdentity,
  readHostedRegistry,
  type RepoIdentity,
} from "../../libswamp/workspace/hosted_roster.ts";
import {
  newWorkspaceLocation,
  realPathOrSelf,
} from "../../libswamp/workspace/workspace_store.ts";

export const ROOT_WORKSPACE_NAME = "host-root";
/** in the host's state folder, which scans only *.wanted.yaml */
export const ROOT_WORKSPACE_RECORD_FILE = "root-workspace.yaml";
/** serve's own default, SERVE_CONFIG_PATH, which the host cannot import: serve_config.ts reaches the registries */
export const SERVE_CONFIG_PATH = ".swamp/serve.yaml";

const MAX_RECORD_BYTES = 64 * 1024;

export interface RootWorkspace {
  readonly name: string;
  /** by its real path, as the roster compares folders */
  readonly folder: string;
  readonly created: boolean;
  /** an earlier root workspace's folder, left on disk when a new one replaced it */
  readonly leftFolder: string | null;
}

export interface RootWorkspaceCreator {
  /** makes and registers the workspace as swamp workspace create does; resolves with its folder */
  create(name: string): Promise<string>;
}

export interface RootWorkspaceDeps {
  readonly stateDir: string;
  readonly store: Pick<HostedRegistryDeps, "registry">;
  /** the folder swamp workspace create would make the workspace in */
  readonly location: () => Promise<string>;
  readonly creator: RootWorkspaceCreator;
  readonly realPath?: (path: string) => Promise<string>;
  readonly repoIdentity?: (folder: string) => Promise<RepoIdentity>;
}

/** where swamp workspace create, run with the host's own dirs, makes the root workspace */
export function rootWorkspaceLocation(dirs: {
  readonly dataDir: string;
  readonly configuredParent: () => Promise<string | undefined>;
}): () => Promise<string> {
  return async () =>
    (await newWorkspaceLocation({
      dataDir: dirs.dataDir,
      os: Deno.build.os,
      configuredParent: dirs.configuredParent,
    }, { name: ROOT_WORKSPACE_NAME })).path;
}

/** repoId is null while a create is pending: started, its repo not yet read */
interface RootWorkspaceRecord {
  readonly folder: string;
  readonly repoId: string | null;
}

const RecordSchema = z.object({
  name: z.literal(ROOT_WORKSPACE_NAME),
  folder: z.string().min(1).refine(isAbsolute, "must be an absolute path"),
  repoId: z.string().min(1).nullable(),
}).strict();

/**
 * the caller holds the host state lock; a folder the host did not make, or one
 * no longer holding the repo it made, is refused and never adopted or removed
 */
export async function resolveRootWorkspace(
  deps: RootWorkspaceDeps,
): Promise<RootWorkspace> {
  const realPath = deps.realPath ?? realPathOrSelf;
  const repoIdentity = deps.repoIdentity ?? folderRepoIdentity;
  const recordFile = join(deps.stateDir, ROOT_WORKSPACE_RECORD_FILE);
  const record = await readRecord(recordFile);
  const read = await readHostedRegistry(deps.store);
  if (read.kind === "unreadable") {
    throw new UserError(
      `The host cannot find its root workspace ${ROOT_WORKSPACE_NAME}: the workspace registry cannot be read: ${read.reason}`,
    );
  }
  const entry = read.registry?.get(ROOT_WORKSPACE_NAME);

  if (entry !== undefined) {
    const folder = await realPath(resolve(entry.path));
    if (
      record === null || await realPath(resolve(record.folder)) !== folder
    ) {
      throw markErrorPaths(
        new UserError(
          `The workspace ${ROOT_WORKSPACE_NAME} at ${entry.path} was not made by this host, so it is not its root workspace. To use it as the root, set root: ${entry.path} in host.yaml; otherwise remove it with swamp workspace remove ${ROOT_WORKSPACE_NAME} and move its folder aside.`,
        ),
        [entry.path],
      );
    }
    const identity = await repoIdentity(folder);
    if (identity.kind === "absent") {
      throw markErrorPaths(
        new UserError(
          `The root workspace ${ROOT_WORKSPACE_NAME} is registered at ${entry.path}, but that folder is gone. Put it back, or run swamp workspace remove ${ROOT_WORKSPACE_NAME} and the host makes a new one on its next start, or set root: in host.yaml to a swamp repo of your own.`,
        ),
        [entry.path],
      );
    }
    const pendingAdopted = record.repoId === null && identity.kind === "id" &&
      entry.origin === "created";
    if (
      identity.kind !== "id" ||
      (!pendingAdopted && identity.repoId !== record.repoId)
    ) {
      throw markErrorPaths(
        new UserError(
          `${entry.path}, registered as the root workspace ${ROOT_WORKSPACE_NAME}, no longer holds the repo the host made there, so the host does not serve it as its root. Put that repo back, or run swamp workspace remove ${ROOT_WORKSPACE_NAME} and move the folder aside so the host makes a new one, or set root: in host.yaml.`,
        ),
        [entry.path],
      );
    }
    // a create that registered before its record was finished
    if (pendingAdopted) {
      await writeRecord(recordFile, { folder, repoId: identity.repoId });
    }
    return {
      name: ROOT_WORKSPACE_NAME,
      folder,
      created: false,
      leftFolder: null,
    };
  }

  const location = await deps.location();
  if (await entryExists(location)) {
    throw markErrorPaths(
      new UserError(
        `The host would create its root workspace ${ROOT_WORKSPACE_NAME} at ${location}, but a folder is already there and ${ROOT_WORKSPACE_NAME} is not registered. Bring it back with: swamp workspace import "${location}" --name ${ROOT_WORKSPACE_NAME}. Or move the folder aside so the host makes a new one, or set root: in host.yaml.`,
      ),
      [location],
    );
  }
  const leftFolder = record !== null &&
      await realPath(resolve(record.folder)) !== await realPath(location) &&
      await entryExists(record.folder)
    ? record.folder
    : null;

  await writeRecord(recordFile, { folder: location, repoId: null });
  let made: string;
  try {
    made = await deps.creator.create(ROOT_WORKSPACE_NAME);
  } catch (error) {
    // a create killed after it registered keeps its pending record, which the next start adopts
    const after = await readHostedRegistry(deps.store);
    if (
      after.kind === "read" &&
      after.registry?.get(ROOT_WORKSPACE_NAME) === undefined
    ) {
      await removeIfPresent(recordFile);
    }
    const failure = new UserError(
      `The host could not create its root workspace ${ROOT_WORKSPACE_NAME}: ${
        messageOf(error).replace(/\.$/, "")
      }. To use a repo of your own, set root: in host.yaml.`,
    );
    failure.cause = error;
    throw failure;
  }
  const folder = await realPath(resolve(made));
  const identity = await repoIdentity(folder);
  if (identity.kind !== "id") {
    throw markErrorPaths(
      new UserError(
        `The host created its root workspace ${ROOT_WORKSPACE_NAME} at ${folder}, but its .swamp.yaml names no repoId (${identity.kind}).`,
      ),
      [folder],
    );
  }
  await writeRecord(recordFile, { folder, repoId: identity.repoId });
  return { name: ROOT_WORKSPACE_NAME, folder, created: true, leftFolder };
}

async function readRecord(file: string): Promise<RootWorkspaceRecord | null> {
  let text: string | null | "not a file";
  try {
    text = await readCapped(file, MAX_RECORD_BYTES);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw unreadableRecord(file, messageOf(error));
  }
  if (text === null) {
    throw unreadableRecord(file, `it is larger than ${MAX_RECORD_BYTES} bytes`);
  }
  if (text === "not a file") throw unreadableRecord(file, "it is not a file");
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw unreadableRecord(file, `it is not valid YAML: ${messageOf(error)}`);
  }
  const parsed = RecordSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.join(".");
    throw unreadableRecord(
      file,
      field === "" ? issue.message : `${field}: ${issue.message}`,
    );
  }
  return { folder: parsed.data.folder, repoId: parsed.data.repoId };
}

async function writeRecord(
  file: string,
  record: RootWorkspaceRecord,
): Promise<void> {
  await atomicWriteTextFile(
    file,
    stringifyYaml({
      name: ROOT_WORKSPACE_NAME,
      folder: record.folder,
      repoId: record.repoId,
    }),
  );
}

function unreadableRecord(file: string, reason: string): UserError {
  return markErrorPaths(
    new UserError(
      `The host's root workspace record ${file} cannot be read: ${reason}. Move it aside and start the host again.`,
    ),
    [file],
  );
}

/** a link counts as present, so a dangling one is never taken for a free folder */
async function entryExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
