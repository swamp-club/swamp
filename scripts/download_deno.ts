#!/usr/bin/env -S deno run -A

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

import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";

const TOOL_VERSIONS_PATH = join(
  import.meta.dirname ?? ".",
  "..",
  ".tool-versions",
);

const TARGET_ARTIFACT_MAP: Record<string, string> = {
  "x86_64-unknown-linux-gnu": "deno-x86_64-unknown-linux-gnu.zip",
  "aarch64-unknown-linux-gnu": "deno-aarch64-unknown-linux-gnu.zip",
  "x86_64-apple-darwin": "deno-x86_64-apple-darwin.zip",
  "aarch64-apple-darwin": "deno-aarch64-apple-darwin.zip",
  "x86_64-pc-windows-msvc": "deno-x86_64-pc-windows-msvc.zip",
};


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
  // strip build metadata: GitHub releases use plain semver
  return match[1].replace(/\+.*$/, "");
}

/**
 * matches the shape denoland/setup-deno parses so CI and this script agree;
 * null when there is no deno line
 */
export function parsePinnedDenoVersion(contents: string): string | null {
  const match = contents.match(/^deno\s+v?(\S+)\s*$/m);
  return match ? match[1] : null;
}

/**
 * throws under CI because release.yml compiles the published binary; off CI it
 * only warns so a maintainer a patch release off the pin is not blocked in
 * verify-build. do not make it unconditional
 */
export function checkVersionAgainstPin(
  running: string,
  pinned: string | null,
  isCi: boolean,
): void {
  if (pinned === null) {
    console.warn(
      `WARNING: no deno pin found in ${TOOL_VERSIONS_PATH}; ` +
        `embedding deno ${running} unverified`,
    );
    return;
  }

  if (running === pinned) {
    return;
  }

  const detail = `deno ${running} is running this build, but .tool-versions ` +
    `pins deno ${pinned}. The running version is what gets embedded in the ` +
    `compiled binary. Install the pinned version (mise install) and retry.`;

  if (isCi) {
    throw new Error(`Embedded deno version does not match the pin: ${detail}`);
  }

  console.warn(`WARNING: embedded deno version does not match the pin.`);
  console.warn(`  ${detail}`);
}

/**
 * a missing or unreadable file only warns, so the script stays runnable outside
 * a full checkout
 */
async function verifyRunningVersion(running: string): Promise<void> {
  let contents: string;
  try {
    contents = await Deno.readTextFile(TOOL_VERSIONS_PATH);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`WARNING: could not read ${TOOL_VERSIONS_PATH}: ${reason}`);
    return;
  }

  checkVersionAgainstPin(
    running,
    parsePinnedDenoVersion(contents),
    Deno.env.get("CI") !== undefined,
  );
}

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

async function extractDenoFromZip(
  zipBytes: Uint8Array,
  binaryName: string,
): Promise<Uint8Array> {
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

  const version = await getDenoVersion();
  await verifyRunningVersion(version);

  const url =
    `https://github.com/denoland/deno/releases/download/v${version}/${artifact}`;

  console.log(`Version: ${version}`);
  console.log(`Target: ${target}`);
  console.log(`Artifact: ${artifact}`);
  console.log(`Source: ${url}`);

  const zipBytes = await downloadFile(url);

  console.log(`Downloaded ${zipBytes.length} bytes, extracting...`);
  const binaryBytes = await extractDenoFromZip(zipBytes, binaryName);

  const outputDir = join(
    import.meta.dirname ?? ".",
    "..",
    "resources",
    "deno",
  );
  await ensureDir(outputDir);

  const outputPath = join(outputDir, binaryName);
  await Deno.writeFile(outputPath, binaryBytes);

  if (!isWindows) {
    await Deno.chmod(outputPath, 0o755);
  }

  const versionPath = join(outputDir, "version.txt");
  await Deno.writeTextFile(versionPath, version);

  const sizeMB = (binaryBytes.length / 1024 / 1024).toFixed(1);
  console.log(`Wrote deno ${version} (${sizeMB} MB) to ${outputPath}`);
  console.log(`Wrote version to ${versionPath}`);
}

if (import.meta.main) {
  await main();
}
