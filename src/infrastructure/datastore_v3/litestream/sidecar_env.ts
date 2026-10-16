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
 * The environment Litestream itself runs with (swamp-club#3534): only what
 * its replica needs, from the table in `design/enablers/datastore-litestream.md`
 * ("the replica target"). The swamp supervisor that starts it keeps its own
 * environment: it resolves the binary through `SWAMP_HOME` and the binary
 * override, and from source it needs Deno's own variables.
 *
 * @module
 */

import type { V3ReplicaSetting } from "./replica_setting.ts";

/** Which kind of replica a Litestream child replicates to. */
export type LitestreamReplicaType = V3ReplicaSetting["type"];

/** The replica kinds a supervisor may be told. */
export const LITESTREAM_REPLICA_TYPES: readonly LitestreamReplicaType[] = [
  "file",
  "s3",
  "gcs",
];

/** Every replica's child gets these. */
const BASE = ["HOME", "PATH"];

/**
 * A bucket replica's network route and trust: the proxy variables in both
 * cases, and the CA bundles of a self-hosted store or a corporate TLS proxy.
 */
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
 * What a child process needs to start on Windows. Replication is refused
 * there while the pin is below the Windows minimum, but the list is kept
 * so that lifting the pin needs no second change.
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

/** The variables each replica kind keeps by name, and by prefix. */
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

/**
 * The environment a Litestream child replicating to a `type` replica gets
 * from `env`: its credentials, `HOME`, `PATH`, and for a bucket the proxy
 * variables and CA bundles. On Windows, where variable names are case
 * insensitive, names are matched so, and what a child process needs to
 * start is kept too.
 */
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

/** Parses a supervisor's `--replica-type`, or undefined when it is not one. */
export function parseLitestreamReplicaType(
  value: string | undefined,
): LitestreamReplicaType | undefined {
  return LITESTREAM_REPLICA_TYPES.find((type) => type === value);
}
