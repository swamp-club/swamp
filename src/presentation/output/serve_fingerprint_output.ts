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

import { bold, cyan, dim } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";
import type { ServeFingerprintData } from "../../libswamp/serve/fingerprint.ts";

function key(label: string): string {
  return bold(cyan(`${label}:`));
}

function counts(record: Record<string, number>): string {
  const entries = Object.entries(record).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return entries.length === 0
    ? dim("none")
    : entries.map(([name, n]) => `${name} ${dim(`(${n})`)}`).join(", ");
}

function list(values: readonly string[]): string {
  return values.length === 0 ? dim("none") : values.join(", ");
}

const RUNTIME_ONLY = dim("known only to a running serve");

export function renderServeFingerprint(
  data: ServeFingerprintData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    // deno-lint-ignore no-console
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const f = data.fingerprint;
  const lines: string[] = [];
  lines.push(`${key("Fingerprint")} ${bold(data.hash)}`);

  lines.push("");
  lines.push(cyan("Build:"));
  lines.push(`  ${key("Swamp version")} ${f.swampVersion}`);
  lines.push(`  ${key("Platform")} ${f.platform}/${f.arch}`);
  lines.push(`  ${key("serve.yaml version")} ${f.serveYamlVersion}`);

  lines.push("");
  lines.push(cyan("Deployment:"));
  lines.push(`  ${key("Mode")} ${bold(f.deploymentMode)}`);
  lines.push(
    `  ${key("Datastore")} ${f.datastoreKind} ${dim(`(${f.datastoreFormat})`)}`,
  );
  lines.push(`  ${key("Vaults")} ${list(f.vaultKinds)}`);
  lines.push(`  ${key("Federation role")} ${f.federationRole}`);

  lines.push("");
  lines.push(cyan("Access:"));
  lines.push(`  ${key("Auth mode")} ${f.authMode}`);
  lines.push(`  ${key("TLS")} ${f.tls ? "on" : "off"}`);
  lines.push(`  ${key("Remote only")} ${f.remoteOnly ? "yes" : "no"}`);
  lines.push(`  ${key("Loopback only")} ${f.loopbackOnly ? "yes" : "no"}`);
  lines.push(`  ${key("Settings hash")} ${dim(f.settingsHash)}`);

  lines.push("");
  lines.push(cyan("Extensions:"));
  if (f.extensions.length === 0) {
    lines.push(`  ${dim("none")}`);
  }
  for (const extension of f.extensions) {
    lines.push(`  ${extension.name} ${dim(extension.version)}`);
  }

  lines.push("");
  lines.push(`${cyan("Pool:")} ${dim("(not part of the fingerprint hash)")}`);
  lines.push(`  ${key("Workers")} ${f.workers.total}`);
  lines.push(`  ${key("By swamp version")} ${counts(f.workers.byVersion)}`);
  lines.push(`  ${key("By label key")} ${counts(f.workers.byLabelKey)}`);

  lines.push("");
  lines.push(
    `${cyan("Runtime:")} ${dim("(not part of the fingerprint hash)")}`,
  );
  lines.push(
    `  ${key("Team")} ${
      f.team === null ? RUNTIME_ONLY : `${f.team.role} (${f.team.nodes} nodes)`
    }`,
  );
  lines.push(`  ${key("Started")} ${f.startedAt ?? RUNTIME_ONLY}`);
  lines.push(
    `  ${key("Ready")} ${f.ready === null ? RUNTIME_ONLY : String(f.ready)}`,
  );

  writeOutput(lines.join("\n"));
}
