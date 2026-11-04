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

/** Host verification and reproducible cross-builds for the experimental Go server. */
import { dirname, fromFileUrl, join, resolve } from "@std/path";

const root = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const moduleDir = join(root, "packages", "serve-go");

async function capture(args: string[]): Promise<string> {
  const result = await new Deno.Command("go", {
    args,
    cwd: moduleDir,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error(`go ${args[0]} failed (${result.code})`);
  return new TextDecoder().decode(result.stdout).trim();
}

async function run(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<void> {
  const result = await new Deno.Command(command, {
    args,
    cwd: moduleDir,
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) {
    throw new Error(`${command} ${args[0]} failed (${result.code})`);
  }
}

async function checkToolchain(): Promise<void> {
  const pins = await Deno.readTextFile(join(root, ".tool-versions"));
  const pin = /^golang\s+(\S+)\s*$/m.exec(pins)?.[1];
  if (!pin) throw new Error(".tool-versions must pin Go");
  const actual = await capture(["env", "GOVERSION"]);
  if (actual !== `go${pin}` && !actual.startsWith(`go${pin}-`)) {
    throw new Error(`Expected Go ${pin} from .tool-versions; found ${actual}`);
  }
}

async function check(): Promise<void> {
  const format = await new Deno.Command("gofmt", {
    args: ["-l", "."],
    cwd: moduleDir,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!format.success || format.stdout.length > 0) {
    throw new Error(
      `Go formatting failed:\n${new TextDecoder().decode(format.stdout)}`,
    );
  }
  await run("go", ["mod", "verify"]);
  await run("go", ["vet", "./..."]);
  const cgo = await capture(["env", "CGO_ENABLED"]);
  const os = await capture(["env", "GOOS"]);
  const arch = await capture(["env", "GOARCH"]);
  const raceSupported = [
    "linux/amd64",
    "linux/arm64",
    "darwin/amd64",
    "darwin/arm64",
    "windows/amd64",
  ].includes(`${os}/${arch}`);
  const race = cgo === "1" && raceSupported;
  console.error(
    race
      ? "Go tests include the race detector"
      : "Go race detector unavailable on this host/toolchain; running ordinary tests",
  );
  await run("go", ["test", ...(race ? ["-race"] : []), "-count=1", "./..."]);
  const temporary = await Deno.makeTempDir({ prefix: "swamp-serve-build-" });
  try {
    await run("go", [
      "build",
      "-trimpath",
      "-o",
      join(temporary, os === "windows" ? "swamp-serve.exe" : "swamp-serve"),
      "./cmd/swamp-serve",
    ]);
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
}

const targets = [
  { os: "linux", arch: "amd64", name: "linux-x86_64" },
  { os: "linux", arch: "arm64", name: "linux-aarch64" },
  { os: "darwin", arch: "amd64", name: "darwin-x86_64" },
  { os: "darwin", arch: "arm64", name: "darwin-aarch64" },
  { os: "windows", arch: "amd64", name: "windows-x86_64.exe" },
];

async function release(
  output: string,
  version: string,
  sha: string,
): Promise<void> {
  // Values reach the Go linker flag grammar. Keep them single literal tokens.
  if (!/^[A-Za-z0-9._-]+$/.test(version) || !/^[a-f0-9]{7,40}$/.test(sha)) {
    throw new Error(
      "Release version and commit must be literal version/hash values",
    );
  }
  const directory = resolve(output);
  await Deno.mkdir(directory, { recursive: true });
  for (const target of targets) {
    await run("go", [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags",
      `-s -w -X main.version=${version} -X main.gitSHA=${sha}`,
      "-o",
      join(directory, `swamp-serve-${target.name}`),
      "./cmd/swamp-serve",
    ], { GOOS: target.os, GOARCH: target.arch, CGO_ENABLED: "0" });
  }
  const protocol = JSON.parse(
    await Deno.readTextFile(join(moduleDir, "protocol.json")),
  ) as Record<string, unknown>;
  await Deno.writeTextFile(
    join(directory, "swamp-serve-pair.json"),
    JSON.stringify(
      {
        experimental: true,
        version,
        engineCommit: sha,
        protocol,
        platforms: targets.map(({ name }) => name),
        validation:
          "Cross-compiled artifacts; native runtime and swamp-uat results are separate release gates.",
      },
      null,
      2,
    ) + "\n",
  );
}

/** Run the same verification/release path used by the command-line entry. */
export async function runServeGo(args: readonly string[]): Promise<void> {
  await checkToolchain();
  const [mode = "check", output, version, sha] = args;
  if (mode === "check" && args.length <= 1) {
    await check();
  } else if (
    mode === "release" && output && version && sha && args.length === 4
  ) {
    await release(output, version, sha);
  } else {
    throw new Error(
      "Usage: scripts/serve_go.ts check | release <output-dir> <version> <commit>",
    );
  }
}

if (import.meta.main) await runServeGo(Deno.args);
