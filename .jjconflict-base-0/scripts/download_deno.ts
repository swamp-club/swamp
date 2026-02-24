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
  return match[1];
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

  const version = await getDenoVersion();
  const isWindows = target.includes("windows");
  const binaryName = isWindows ? "deno.exe" : "deno";

  console.log(`Deno version: ${version}`);
  console.log(`Target: ${target}`);
  console.log(`Artifact: ${artifact}`);

  const url =
    `https://github.com/denoland/deno/releases/download/v${version}/${artifact}`;
  const zipBytes = await downloadFile(url);

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
  await Deno.writeTextFile(versionPath, version);

  const sizeMB = (binaryBytes.length / 1024 / 1024).toFixed(1);
  console.log(`Wrote deno ${version} (${sizeMB} MB) to ${outputPath}`);
  console.log(`Wrote version to ${versionPath}`);
}

if (import.meta.main) {
  await main();
}
