#!/usr/bin/env -S deno run -A

// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";

/** Maps Deno build target triples to GitHub release artifact names. */
const TARGET_ARTIFACT_MAP: Record<string, string> = {
  "x86_64-unknown-linux-gnu": "deno-x86_64-unknown-linux-gnu.zip",
  "aarch64-unknown-linux-gnu": "deno-aarch64-unknown-linux-gnu.zip",
  "x86_64-apple-darwin": "deno-x86_64-apple-darwin.zip",
  "aarch64-apple-darwin": "deno-aarch64-apple-darwin.zip",
  "x86_64-pc-windows-msvc": "deno-x86_64-pc-windows-msvc.zip",
};

// CANARY-BRIDGE: temporary opt-in for shipping a pinned Deno canary commit
// while waiting for an upstream stable release. Remove this entire block
// (and the call site in main(), and scripts/deno_canary.txt) when the
// targeted stable release ships. See scripts/deno_canary.txt for the
// full back-out checklist.
const CANARY_PIN_FILE = "deno_canary.txt";

/**
 * Returns the canary commit SHA to download, or null for stable mode.
 *
 * Priority:
 *   1. `DENO_CANARY_SHA` env var (CI ad-hoc override).
 *   2. `scripts/deno_canary.txt` (committed pin — first non-blank,
 *      non-`#`-comment line).
 *   3. null — fall through to the stable GitHub-releases path.
 */
async function readCanarySha(): Promise<string | null> {
  const fromEnv = Deno.env.get("DENO_CANARY_SHA")?.trim();
  if (fromEnv) return fromEnv;

  const pinPath = join(import.meta.dirname ?? ".", CANARY_PIN_FILE);
  let content: string;
  try {
    content = await Deno.readTextFile(pinPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return line;
  }
  return null;
}

export interface DownloadPlan {
  url: string;
  versionLabel: string;
  channel: "stable" | "canary";
}

/**
 * Builds the download URL and the string written to `version.txt`.
 *
 * Stable channel uses the GitHub releases artifact path; canary uses
 * `dl.deno.land/canary/<sha>/`. The `versionLabel` distinguishes canary
 * builds (`canary-<short-sha>`) so the runtime's version-marker check
 * forces a fresh extraction on every SHA bump.
 */
export function buildDownloadPlan(
  channel: "stable" | "canary",
  versionOrSha: string,
  artifact: string,
): DownloadPlan {
  if (channel === "canary") {
    return {
      url: `https://dl.deno.land/canary/${versionOrSha}/${artifact}`,
      versionLabel: `canary-${versionOrSha.slice(0, 8)}`,
      channel,
    };
  }
  return {
    url:
      `https://github.com/denoland/deno/releases/download/v${versionOrSha}/${artifact}`,
    versionLabel: versionOrSha,
    channel,
  };
}
// END CANARY-BRIDGE

/** Maps Deno.build.os + Deno.build.arch to a target triple. */
function detectCurrentTarget(): string {
  const os = Deno.build.os;
  const arch = Deno.build.arch;

  if (os === "linux" && arch === "x86_64") {
    return "x86_64-unknown-linux-gnu";
  }
  if (os === "linux" && arch === "aarch64") {
    return "aarch64-unknown-linux-gnu";
  }
  if (os === "darwin" && arch === "x86_64") {
    return "x86_64-apple-darwin";
  }
  if (os === "darwin" && arch === "aarch64") {
    return "aarch64-apple-darwin";
  }
  if (os === "windows" && arch === "x86_64") {
    return "x86_64-pc-windows-msvc";
  }
  throw new Error(`Unsupported platform: ${os}/${arch}`);
}

/** Parses the deno version from the currently running deno. */
async function getDenoVersion(): Promise<string> {
  const command = new Deno.Command("deno", {
    args: ["--version"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const text = new TextDecoder().decode(output.stdout);
  const match = text.match(/^deno\s+(\S+)/);
  if (!match) {
    throw new Error(`Cannot parse deno version from: ${text}`);
  }
  // Strip build metadata suffix (e.g. "2.7.0+fb4db33" → "2.7.0")
  // GitHub releases use semver without build metadata
  return match[1].replace(/\+.*$/, "");
}

/** Downloads a file from a URL, returning the bytes. */
async function downloadFile(url: string): Promise<Uint8Array> {
  console.log(`Downloading: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText} for ${url}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Extracts a zip archive and returns the contents of the deno binary. */
async function extractDenoFromZip(
  zipBytes: Uint8Array,
  binaryName: string,
): Promise<Uint8Array> {
  // Write zip to temp file, extract with unzip
  const tempDir = await Deno.makeTempDir({ prefix: "swamp_deno_download_" });
  const zipPath = join(tempDir, "deno.zip");

  try {
    await Deno.writeFile(zipPath, zipBytes);

    const command = new Deno.Command("unzip", {
      args: ["-o", zipPath, "-d", tempDir],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`unzip failed: ${stderr}`);
    }

    const binaryPath = join(tempDir, binaryName);
    return await Deno.readFile(binaryPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["target"],
    alias: { "t": "target" },
  });

  const target = args.target ?? detectCurrentTarget();
  const artifact = TARGET_ARTIFACT_MAP[target];
  if (!artifact) {
    console.error(`Unknown target: ${target}`);
    console.error(`Supported targets: ${Object.keys(TARGET_ARTIFACT_MAP).join(", ")}`);
    Deno.exit(1);
  }

  const isWindows = target.includes("windows");
  const binaryName = isWindows ? "deno.exe" : "deno";

  // CANARY-BRIDGE: pick channel from deno_canary.txt / DENO_CANARY_SHA
  // (returns null in stable mode). Remove this branch when the bridge ends.
  const canarySha = await readCanarySha();
  const plan = canarySha
    ? buildDownloadPlan("canary", canarySha, artifact)
    : buildDownloadPlan("stable", await getDenoVersion(), artifact);

  console.log(`Channel: ${plan.channel}`);
  console.log(`Target: ${target}`);
  console.log(`Artifact: ${artifact}`);
  console.log(`Source: ${plan.url}`);

  const zipBytes = await downloadFile(plan.url);

  console.log(`Downloaded ${zipBytes.length} bytes, extracting...`);
  const binaryBytes = await extractDenoFromZip(zipBytes, binaryName);

  // Write to resources/deno/
  const outputDir = join(
    import.meta.dirname ?? ".",
    "..",
    "resources",
    "deno",
  );
  await ensureDir(outputDir);

  const outputPath = join(outputDir, binaryName);
  await Deno.writeFile(outputPath, binaryBytes);

  // Set executable permissions on unix
  if (!isWindows) {
    await Deno.chmod(outputPath, 0o755);
  }

  // Write version file
  const versionPath = join(outputDir, "version.txt");
  await Deno.writeTextFile(versionPath, plan.versionLabel);

  const sizeMB = (binaryBytes.length / 1024 / 1024).toFixed(1);
  console.log(`Wrote deno ${plan.versionLabel} (${sizeMB} MB) to ${outputPath}`);
  console.log(`Wrote version to ${versionPath}`);
}

if (import.meta.main) {
  await main();
}
