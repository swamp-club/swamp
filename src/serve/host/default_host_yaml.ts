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

import { dirname, join } from "@std/path";
import { markErrorPaths, UserError } from "../../domain/errors.ts";

// on loopback with no proxy this address is the listener's own; off loopback needs TLS files no default can name
export const DEFAULT_HOST_YAML =
  `# Written by the first swamp serve host run. Edit it and restart the host.
# Relative paths are taken from the folder that holds this file.

# The listener. Off loopback it needs TLS: set cert-file and key-file together.
listen:
  host: 127.0.0.1
  port: 8080
  # cert-file: tls/cert.pem
  # key-file: tls/key.pem

# The public address every workspace answers under, at <address>/w/<name>.
address: http://127.0.0.1:8080

# The root workspace's swamp repo, served at the address itself. It takes the
# swamp serve workspace commands and issues sign-in codes. It must not be
# inside the host's state folder nor contain it.
# root: /path/to/root-repo

# The host is behind a proxy whose forwarding headers it passes on.
# trust-proxy: true

# Admits a workspace in auth mode none behind a proxy that authenticates every
# caller; only on a loopback listener with trust-proxy or a public address.
# allow-unauthenticated-behind-proxy: true

# One OAuth client every workspace is started with. Keep the secret file
# outside every repo the host runs.
# oauth-client:
#   id: my-client-id
#   secret-file: /path/to/oauth-client-secret
`;

export interface DefaultHostYaml {
  readonly text: string;
  /** false when another host created the file first */
  readonly created: boolean;
}

export interface DefaultHostYamlDeps {
  readonly link?: (from: string, to: string) => Promise<void>;
  readonly readTextFile?: (path: string) => Promise<string>;
}

/** creates host.yaml at path with the defaults, never replacing a file there */
export async function createDefaultHostYaml(
  path: string,
  deps: DefaultHostYamlDeps = {},
): Promise<DefaultHostYaml> {
  const link = deps.link ?? Deno.link;
  const readTextFile = deps.readTextFile ?? Deno.readTextFile;
  const dir = dirname(path);
  const cannotCreate = (error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    return markErrorPaths(
      new UserError(`Cannot create ${path}: ${reason}`),
      [path],
    );
  };
  const readExisting = async (): Promise<DefaultHostYaml> => {
    try {
      return { text: await readTextFile(path), created: false };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw markErrorPaths(
          new UserError(
            `Cannot read ${path}: something is there, such as a link that points nowhere, but it cannot be read. Remove it or point it at a host.yaml`,
          ),
          [path],
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw markErrorPaths(
        new UserError(`Cannot read ${path}: ${reason}`),
        [path],
      );
    }
  };

  const bytes = new TextEncoder().encode(DEFAULT_HOST_YAML);
  let tmpPath: string;
  try {
    await Deno.mkdir(dir, { recursive: true });
    tmpPath = join(dir, `.${crypto.randomUUID()}.tmp`);
    // synced and closed before the link so the link never names content not yet on disk
    const tmp = await Deno.open(tmpPath, { write: true, createNew: true });
    try {
      await writeAll(tmp, bytes);
      await tmp.sync();
    } catch (error) {
      tmp.close();
      await Deno.remove(tmpPath).catch(() => {});
      throw error;
    }
    tmp.close();
  } catch (error) {
    throw cannotCreate(error);
  }

  // the link fails if the path exists, so one of two hosts starting at once
  // writes the file and neither reader ever sees it partly written
  let linked = false;
  let exists = false;
  try {
    await link(tmpPath, path);
    linked = true;
  } catch (error) {
    // any other failure is a filesystem without hard links, which falls through to an exclusive create
    exists = error instanceof Deno.errors.AlreadyExists;
  } finally {
    await Deno.remove(tmpPath).catch(() => {});
  }
  if (linked) return { text: DEFAULT_HOST_YAML, created: true };
  if (exists) return await readExisting();

  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { write: true, createNew: true });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) return await readExisting();
    throw cannotCreate(error);
  }
  try {
    await writeAll(file, bytes);
    await file.sync();
  } catch (error) {
    file.close();
    // created exclusively above, so the partial file is this call's own
    await Deno.remove(path).catch(() => {});
    throw cannotCreate(error);
  }
  file.close();
  return { text: DEFAULT_HOST_YAML, created: true };
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    written += await file.write(bytes.subarray(written));
  }
}
