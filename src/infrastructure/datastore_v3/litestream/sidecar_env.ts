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
 * only what its replica needs; the supervisor keeps its own environment since
 * it resolves the binary through SWAMP_HOME and the override, and from source
 * needs Deno's variables
 */

import type { V3ReplicaSetting } from "./replica_setting.ts";

export type LitestreamReplicaType = V3ReplicaSetting["type"];

export const LITESTREAM_REPLICA_TYPES: readonly LitestreamReplicaType[] = [
  "file",
  "s3",
  "gcs",
];

const BASE = ["HOME", "PATH"];

const NETWORK = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/**
 * what a child process needs to start on Windows; kept though replication is
 * refused there while the pin is below the Windows minimum
 */
const WINDOWS = [
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];

const KEPT: Record<
  LitestreamReplicaType,
  { readonly names: readonly string[]; readonly prefixes: readonly string[] }
> = {
  file: { names: BASE, prefixes: [] },
  s3: { names: [...BASE, ...NETWORK], prefixes: ["AWS_"] },
  gcs: {
    // STORAGE_EMULATOR_HOST is how both the GCS extension and Litestream
    // reach an emulator: without it Litestream would replicate to real GCS
    // while storage() writes to the emulator. The extension refuses an
    // apiEndpoint that it does not name.
    names: [
      ...BASE,
      ...NETWORK,
      "GOOGLE_APPLICATION_CREDENTIALS",
      "STORAGE_EMULATOR_HOST",
    ],
    prefixes: ["CLOUDSDK_"],
  },
};

export function litestreamChildEnv(
  type: LitestreamReplicaType,
  env: Readonly<Record<string, string>>,
  os: typeof Deno.build.os = Deno.build.os,
): Record<string, string> {
  const windows = os === "windows";
  const fold = (name: string) => windows ? name.toUpperCase() : name;
  const kept = KEPT[type];
  const names = new Set(
    [...kept.names, ...(windows ? WINDOWS : [])].map(fold),
  );
  const prefixes = kept.prefixes.map(fold);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const key = fold(name);
    if (names.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) {
      out[name] = value;
    }
  }
  return out;
}

export function parseLitestreamReplicaType(
  value: string | undefined,
): LitestreamReplicaType | undefined {
  return LITESTREAM_REPLICA_TYPES.find((type) => type === value);
}
