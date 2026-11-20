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
/** under the data dir */
const HOST_STATE_DIR = "host";

/** where a host reads host.yaml and keeps its wanted, status and lock files */
export interface HostLayout {
  /** the host.yaml read */
  readonly configFile: string;
  /** what relative paths in host.yaml are taken from */
  readonly baseDir: string;
  /** the wanted, status and lock files; it holds no repo */
  readonly stateDir: string;
}

export function hostLayout(
  dirs: { readonly configDir: string; readonly dataDir: string },
): HostLayout {
  const configDir = resolve(dirs.configDir);
  return {
    configFile: join(configDir, HOST_CONFIG_FILE),
    baseDir: configDir,
    stateDir: join(resolve(dirs.dataDir), HOST_STATE_DIR),
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

export async function locateHostYaml(
  dirs: { readonly configDir: string; readonly dataDir: string },
  read: HostYamlReader = readHostYamlFile,
  create: HostYamlCreator = createDefaultHostYaml,
): Promise<{ layout: HostLayout; text: string; created: boolean }> {
  const layout = hostLayout(dirs);
  let text: string | null;
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
  const created = await create(layout.configFile);
  return { layout, text: created.text, created: created.created };
}
