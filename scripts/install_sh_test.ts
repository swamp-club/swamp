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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const repo = fromFileUrl(new URL("../", import.meta.url));
const bare = "20261021.120000.0";
const full = `${bare}-sha.abcdef12`;
const origin = "https://artifacts.swamp-club.com";
const platform = `${Deno.build.os}-${Deno.build.arch}`;
const [os, arch] = platform.split("-");
const decoder = new TextDecoder();
// install.sh is the Unix installer; install.ps1 covers Windows.
const ignore = Deno.build.os === "windows";

function archiveKey(version: string): string {
  return `swamp/${version}/binary/${os}/${arch}/swamp-${version}-binary-${platform}.tar.gz`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const stubCurl = `#!/bin/bash
set -uo pipefail
printf '%s\\n' "$*" >> "$FIXTURE_ROOT/calls"
[[ -z "\u0024{NETWORK_DOWN:-}" ]] || exit 6
url="" out="" headers="" head=false fail=false effective=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        https://*) url="$1" ;;
        -o) shift; out="$1" ;;
        -D) shift; headers="$1" ;;
        -w) shift; effective=true ;;
        -sSI) head=true ;;
        -sSfL) fail=true ;;
        --proto|--proto-redir|--max-filesize) shift ;;
    esac
    shift
done
key="\u0024{url#${origin}/}"
file="$FIXTURE_ROOT/store/$key"
status=200
[[ -f "$file" || "$key" == swamp/stable/* ]] || status=404
if [[ "$key" == */version && -n "\u0024{POINTER_STATUS:-}" ]]; then
    status="$POINTER_STATUS"
fi
if $head; then
    printf 'HTTP/1.1 %s\\r\\n' "$status"
    # Stable is an S3 website redirect to a versioned object, as in production.
    if [[ "$key" == swamp/stable/* ]]; then
        printf 'x-amz-meta-x-amz-website-redirect-location: %s\\r\\n' "\u0024{url//stable/$FULL}"
    fi
    printf '\\r\\n'
    exit 0
fi
[[ -z "$headers" ]] || printf 'HTTP/1.1 %s\\r\\ncontent-type: text/plain\\r\\n\\r\\n' "$status" > "$headers"
if [[ "$status" != 200 ]]; then
    $fail && exit 22
    exit 0
fi
if [[ -n "$out" ]]; then cp "$file" "$out"; else cat "$file"; fi
! $effective || printf '%s' "$url"
`;

interface Fixture {
  store: string;
  dest: string;
  setPointer: (body: string) => Promise<void>;
  run: (
    version: string,
    env?: Record<string, string>,
  ) => Promise<{ success: boolean; output: string }>;
  calls: () => Promise<string[]>;
}

async function withInstaller(fn: (f: Fixture) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "install-sh-" });
  const bin = join(root, "bin");
  const store = join(root, "store");
  const dest = join(root, "dest");
  const build = join(root, "build");
  try {
    for (const dir of [bin, store, dest, build]) await Deno.mkdir(dir);
    await Deno.writeTextFile(join(bin, "curl"), stubCurl, { mode: 0o755 });
    await Deno.writeTextFile(join(root, "calls"), "");
    await Deno.writeTextFile(
      join(build, "swamp"),
      `#!/bin/sh\necho "swamp ${full}"\n`,
      { mode: 0o755 },
    );
    const key = archiveKey(full);
    await Deno.mkdir(join(store, dirname(key)), { recursive: true });
    const tar = await new Deno.Command("tar", {
      args: ["-czf", join(store, key), "-C", build, "swamp"],
    }).output();
    assert(tar.success, decoder.decode(tar.stderr));
    const bytes = await Deno.readFile(join(store, key));
    await Deno.writeTextFile(
      join(store, `${key}.sha256`),
      `${await sha256(bytes)}  ${key.split("/").at(-1)}\n`,
    );
    await fn({
      store,
      dest,
      async setPointer(body) {
        await Deno.mkdir(join(store, "swamp", bare), { recursive: true });
        await Deno.writeTextFile(join(store, "swamp", bare, "version"), body);
      },
      async run(version, env = {}) {
        const result = await new Deno.Command("sh", {
          args: [
            join(repo, "scripts", "install.sh"),
            `--version=${version}`,
            `--platform=${platform}`,
            `--destination=${dest}`,
          ],
          env: {
            PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
            HOME: root,
            FIXTURE_ROOT: root,
            FULL: full,
            TERM: "dumb",
            ...env,
          },
          clearEnv: true,
          stdout: "piped",
          stderr: "piped",
        }).output();
        return {
          success: result.success,
          output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
        };
      },
      async calls() {
        return (await Deno.readTextFile(join(root, "calls"))).trim().split("\n")
          .filter((line) => line !== "");
      },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function pointerRequests(calls: string[]): string[] {
  return calls.filter((call) => call.includes(`/swamp/${bare}/version`));
}

function archiveRequests(calls: string[]): string[] {
  return calls.filter((call) => call.includes(".tar.gz"));
}

Deno.test({
  name: "install.sh: resolves a bare version through its pointer and installs the full release",
  ignore,
  fn: () =>
    withInstaller(async (f) => {
      await f.setPointer(`${full}\n`);
      const result = await f.run(bare);
      assert(result.success, result.output);
      assertStringIncludes(result.output, `Resolved version '${bare}' to '${full}'`);
      assertStringIncludes(result.output, `release '${full}' complete`);
      const installed = await new Deno.Command(join(f.dest, "swamp"), {
        args: ["--version"],
      }).output();
      assertEquals(decoder.decode(installed.stdout).trim(), `swamp ${full}`);
      const calls = await f.calls();
      assertEquals(pointerRequests(calls).length, 1);
      assert(archiveRequests(calls).every((call) => call.includes(full)));
    }),
});

Deno.test({
  name: "install.sh: accepts a pointer without a trailing newline",
  ignore,
  fn: () =>
    withInstaller(async (f) => {
      await f.setPointer(full);
      const result = await f.run(bare);
      assert(result.success, result.output);
    }),
});

Deno.test({
  name: "install.sh: a missing pointer reports no release and fetches no archive",
  ignore,
  fn: () =>
    withInstaller(async (f) => {
      const result = await f.run(bare);
      assert(!result.success);
      assertStringIncludes(
        result.output,
        `No swamp release found for version '${bare}'`,
      );
      assertEquals(archiveRequests(await f.calls()), []);
    }),
});

Deno.test({
  name: "install.sh: a pointer server error reports its HTTP status",
  ignore,
  fn: () =>
    withInstaller(async (f) => {
      await f.setPointer(`${full}\n`);
      const result = await f.run(bare, { POINTER_STATUS: "500" });
      assert(!result.success);
      assertStringIncludes(result.output, "failed with HTTP status 500");
      assertEquals(archiveRequests(await f.calls()), []);
    }),
});

Deno.test({
  name: "install.sh: an unreachable pointer reports the URL",
  ignore,
  fn: () =>
    withInstaller(async (f) => {
      const result = await f.run(bare, { NETWORK_DOWN: "true" });
      assert(!result.success);
      assertStringIncludes(result.output, `Could not reach ${origin}/swamp/${bare}/version`);
    }),
});

for (
  const [label, body] of [
    ["another release", "20261021.120001.0-sha.abcdef12\n"],
    ["a CR", `${full}\r\n`],
    ["a second line", `${full}\n${full}\n`],
    ["two trailing newlines", `${full}\n\n`],
    ["extra text", `${full} extra\n`],
    ["an uppercase suffix", `${bare}-sha.ABCDEF12\n`],
    ["a short suffix", `${bare}-sha.abc\n`],
    ["a long suffix", `${bare}-sha.${"a".repeat(41)}\n`],
    ["a path suffix", `${bare}-sha.abcdef12/../../x\n`],
    ["an empty body", ""],
    ["an oversized body", `${full}${"0".repeat(4096)}\n`],
  ]
) {
  Deno.test({
    name: `install.sh: refuses a pointer with ${label}`,
    ignore,
    fn: () =>
      withInstaller(async (f) => {
        await f.setPointer(body);
        const result = await f.run(bare);
        assert(!result.success);
        assertStringIncludes(
          result.output,
          `Invalid release version pointer for '${bare}'`,
        );
        assertEquals(archiveRequests(await f.calls()), []);
      }),
  });
}

for (const version of [full, "stable"]) {
  Deno.test({
    name: `install.sh: ${version} never requests a version pointer`,
    ignore,
    fn: () =>
      withInstaller(async (f) => {
        await f.setPointer(`${full}\n`);
        const result = await f.run(version);
        assert(result.success, result.output);
        assertEquals(pointerRequests(await f.calls()), []);
      }),
  });
}

for (const version of ["20261021.120000", "2026102.120000.0", "20261021.120000.0a"]) {
  Deno.test({
    name: `install.sh: ${version} is not treated as a bare version`,
    ignore,
    fn: () =>
      withInstaller(async (f) => {
        await f.run(version);
        assertEquals(
          (await f.calls()).filter((call) => call.endsWith("/version")),
          [],
        );
      }),
  });
}
