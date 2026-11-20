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

import { join, resolve } from "@std/path";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  createDefaultHostYaml,
  type DefaultHostYaml,
} from "./default_host_yaml.ts";

export const HOST_CONFIG_FILE = "host.yaml";
export const WORKSPACES_DIR = "workspaces";
/** under the data dir, for a host with no host folder */
const HOST_STATE_DIR = "host";

/** where a host reads host.yaml and keeps its wanted, status and lock files */
export interface HostLayout {
  /** the host.yaml read */
  readonly configFile: string;
  /** what relative paths in host.yaml are taken from */
  readonly baseDir: string;
  /** the wanted, status and lock files */
  readonly stateDir: string;
  /** null for a host with no host folder, whose state folder holds no repo */
  readonly hostFolder: string | null;
}

export function hostFolderLayout(hostDir: string): HostLayout {
  const dir = resolve(hostDir);
  return {
    configFile: join(dir, HOST_CONFIG_FILE),
    baseDir: dir,
    stateDir: join(dir, WORKSPACES_DIR),
    hostFolder: dir,
  };
}

export function noHostFolderLayout(
  dirs: { readonly configDir: string; readonly dataDir: string },
): HostLayout {
  const configDir = resolve(dirs.configDir);
  return {
    configFile: join(configDir, HOST_CONFIG_FILE),
    baseDir: configDir,
    stateDir: join(resolve(dirs.dataDir), HOST_STATE_DIR),
    hostFolder: null,
  };
}

/** resolves with null when the file does not exist; rejects on any other failure */
export type HostYamlReader = (path: string) => Promise<string | null>;

const readHostYamlFile: HostYamlReader = async (path) => {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
};

/** creates host.yaml at path, or reads the one another host created first */
export type HostYamlCreator = (path: string) => Promise<DefaultHostYaml>;

const realPathOrResolved = async (path: string): Promise<string> => {
  try {
    return await Deno.realPath(path);
  } catch {
    return resolve(path);
  }
};

export async function locateHostYaml(
  input: {
    readonly hostDir?: string;
    readonly cwd: string;
    readonly configDir: string;
    readonly dataDir: string;
  },
  read: HostYamlReader = readHostYamlFile,
  realPath: (path: string) => Promise<string> = realPathOrResolved,
  create: HostYamlCreator = createDefaultHostYaml,
): Promise<{ layout: HostLayout; text: string; created: boolean }> {
  // a cwd that is the config dir is no host folder, so starting there gives its host.yaml no second state folder
  const cwdIsConfigDir = input.hostDir === undefined &&
    await realPath(input.cwd) === await realPath(input.configDir);
  const candidates = input.hostDir !== undefined
    ? [hostFolderLayout(resolve(input.cwd, input.hostDir))]
    : cwdIsConfigDir
    ? [noHostFolderLayout(input)]
    : [hostFolderLayout(input.cwd), noHostFolderLayout(input)];
  for (const layout of candidates) {
    let text: string | null;
    // only a missing file moves on; an unreadable one is never passed over for another host's file
    try {
      text = await read(layout.configFile);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw markErrorPaths(
        new UserError(`Cannot read ${layout.configFile}: ${reason}`),
        [layout.configFile],
      );
    }
    if (text !== null) return { layout, text, created: false };
  }
  if (input.hostDir === undefined) {
    // only ever the config dir's, so a host folder is never made implicitly
    const layout = noHostFolderLayout(input);
    const { text, created } = await create(layout.configFile);
    return { layout, text, created };
  }
  const looked = candidates.map((layout) => layout.configFile);
  throw markErrorPaths(
    new UserError(
      `No ${HOST_CONFIG_FILE} in the host folder ${
        candidates[0].hostFolder
      }: looked for ${
        looked[0]
      }. Put one there, or run swamp serve host without --host-dir to use the config dir's, which the first run creates. A ${HOST_CONFIG_FILE} needs at least the public address, such as address: https://serve.example.com`,
    ),
    looked,
  );
}
