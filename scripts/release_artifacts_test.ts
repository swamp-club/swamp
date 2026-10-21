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
import { fromFileUrl, join } from "@std/path";
import { parse } from "@std/yaml";

const repo = fromFileUrl(new URL("../", import.meta.url));
const version = "20261021.120000.0-sha.abcdef12";
const assets = [
  ["swamp-darwin-aarch64", "darwin/aarch64"],
  ["swamp-darwin-x86_64", "darwin/x86_64"],
  ["swamp-linux-x86_64", "linux/x86_64"],
  ["swamp-linux-aarch64", "linux/aarch64"],
  ["swamp-windows-x86_64.zip", "windows/x86_64"],
];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(
    new Uint8Array(hash),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

function objectKey(platform: string): string {
  const ext = platform.startsWith("windows/") ? "zip" : "tar.gz";
  return `swamp/${version}/binary/${platform}/swamp-${version}-binary-${
    platform.replace("/", "-")
  }.${ext}`;
}

// Run the real publishing shell scripts and real archive/hash tools against a
// local object store. No cloud credentials, network, or swamp CLI are used.
async function withStore(
  fn: (fixture: {
    dist: string;
    store: string;
    download: string;
    run: (
      script: string,
      args?: string[],
      env?: Record<string, string>,
      umask?: string,
    ) => Promise<{ success: boolean; output: string }>;
    calls: () => Promise<string>;
  }) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "release-artifacts-" });
  const dist = join(root, "dist");
  const bin = join(root, "bin");
  const store = join(root, "store");
  try {
    for (const dir of [dist, bin, store]) await Deno.mkdir(dir);
    let checksums = "";
    for (const [name] of assets) {
      const content = encoder.encode(`fixture ${name}`);
      await Deno.writeFile(join(dist, name), content);
      checksums += `${await sha256(content)}  ${name}\n`;
    }
    await Deno.writeTextFile(join(dist, "checksums.txt"), checksums);
    const mock = `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FIXTURE_ROOT/calls"
[[ "$*" != *stable* ]] || exit 90
[[ "$1" == storage ]] || exit 91
if [[ "$2" == cp ]]; then
    if [[ "$3" == gs://* ]]; then
        [[ "\u0024{FAIL_READ:-}" != true ]] || exit 7
        cp "$FIXTURE_ROOT/store/\u0024{3#gs://swamp-club-artifacts/}" "$4"
    else
        [[ "\u0024{FAIL_UPLOAD:-}" != true ]] || exit 8
        [[ "$*" == *--if-generation-match=0* ]] || exit 92
        target="$FIXTURE_ROOT/store/\u0024{4#gs://swamp-club-artifacts/}"
        [[ ! -e "$target" ]] || exit 1
        mkdir -p "$(dirname "$target")"
        cp "$3" "$target"
    fi
elif [[ "$2" == cat ]]; then
    [[ "\u0024{FAIL_READ:-}" != true ]] || exit 7
    cat "$FIXTURE_ROOT/store/\u0024{3#gs://swamp-club-artifacts/}"
else
    exit 93
fi
`;
    await Deno.writeTextFile(join(bin, "gcloud"), mock, { mode: 0o755 });
    // macOS has shasum; Linux runners have sha256sum. Keep the real hash tool.
    if (Deno.build.os === "darwin") {
      await Deno.writeTextFile(
        join(bin, "sha256sum"),
        '#!/bin/bash\nexec shasum -a 256 "$@"\n',
        { mode: 0o755 },
      );
    }
    await Deno.writeTextFile(join(root, "calls"), "");
    await fn({
      dist,
      store,
      download: join(root, "download"),
      async run(script, args = [version], env = {}, umask = "022") {
        const result = await new Deno.Command("bash", {
          args: [
            "-c",
            'umask "$1"; shift; exec bash "$@"',
            "release-test",
            umask,
            join(repo, "scripts", script),
            ...args,
          ],
          cwd: repo,
          env: {
            PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
            FIXTURE_ROOT: root,
            BINARIES_DIR: dist,
            GCS_BUCKET: "swamp-club-artifacts",
            FAIL_READ: "",
            FAIL_UPLOAD: "",
            ...env,
          },
          stdout: "piped",
          stderr: "piped",
        }).output();
        return {
          success: result.success,
          output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
        };
      },
      calls: () => Deno.readTextFile(join(root, "calls")),
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const upload = "upload_release_artifacts.sh";
const download = "download_release_artifact.sh";

Deno.test("release uploader publishes five verified variants and never accesses stable", () =>
  withStore(async (f) => {
    const result = await f.run(upload);
    assert(result.success, result.output);
    for (const [name, platform] of assets) {
      const key = objectKey(platform);
      const bytes = await Deno.readFile(join(f.store, key));
      assertEquals(
        await Deno.readTextFile(join(f.store, `${key}.sha256`)),
        `${await sha256(bytes)}  ${key.split("/").at(-1)}\n`,
      );
      if (platform.startsWith("windows/")) {
        assertEquals(bytes, await Deno.readFile(join(f.dist, name)));
      }
    }
    assertEquals((await f.calls()).trim().split("\n").length, 10);
  }));

Deno.test("release archives normalize ownership, mode and time across retries", () =>
  withStore(async (f) => {
    assert((await f.run(upload)).success);
    const bytes = await Deno.readFile(join(f.store, objectKey("linux/x86_64")));
    const stream = new Blob([bytes]).stream().pipeThrough(
      new DecompressionStream("gzip"),
    );
    const tar = new Uint8Array(await new Response(stream).arrayBuffer());
    const field = (start: number, end: number) =>
      decoder.decode(tar.slice(start, end)).replaceAll("\0", "").trim();
    assertEquals(field(0, 100), "swamp");
    assertEquals(parseInt(field(100, 108), 8), 0o755);
    assertEquals(parseInt(field(108, 116), 8), 0);
    assertEquals(parseInt(field(116, 124), 8), 0);
    assertEquals(parseInt(field(136, 148), 8), 0);
    assertEquals(field(265, 297), "");
    assertEquals(field(297, 329), "");
    for (const [name] of assets) {
      await Deno.chmod(join(f.dist, name), 0o600);
      await Deno.utime(join(f.dist, name), 123456789, 123456789);
    }
    const retry = await f.run(upload, [version], {}, "077");
    assert(retry.success, retry.output);
    assertEquals(
      await Deno.readFile(join(f.store, objectKey("linux/x86_64"))),
      bytes,
    );
  }));

for (
  const invalid of ["", "stable", "../release", "20261021.120000.0-sha.BAD"]
) {
  Deno.test(`release uploader rejects invalid version ${JSON.stringify(invalid)}`, () =>
    withStore(async (f) => {
      assert(!(await f.run(upload, [invalid])).success);
      assertEquals(await f.calls(), "");
    }));
}

for (
  const fault of ["missing asset", "missing checksum", "mismatched checksum"]
) {
  Deno.test(`release uploader refuses ${fault} before any upload`, () =>
    withStore(async (f) => {
      const name = assets.at(-1)![0];
      if (fault === "missing asset") await Deno.remove(join(f.dist, name));
      if (fault === "missing checksum") {
        const path = join(f.dist, "checksums.txt");
        await Deno.writeTextFile(
          path,
          (await Deno.readTextFile(path)).split("\n")
            .filter((line) => !line.endsWith(name)).join("\n"),
        );
      }
      if (fault === "mismatched checksum") {
        await Deno.writeTextFile(join(f.dist, name), "corrupted");
      }
      assert(!(await f.run(upload)).success);
      assertEquals(await f.calls(), "");
    }));
}

Deno.test("release uploader rejects conflicting existing objects without overwriting", () =>
  withStore(async (f) => {
    assert((await f.run(upload)).success);
    const key = join(f.store, objectKey("darwin/aarch64"));
    await Deno.writeTextFile(key, "conflicting bytes");
    const result = await f.run(upload);
    assert(!result.success);
    assertStringIncludes(result.output, "Existing artifact differs");
    assertEquals(await Deno.readTextFile(key), "conflicting bytes");
  }));

Deno.test("release uploader propagates upload failure and failed retry reads", () =>
  withStore(async (f) => {
    assert(!(await f.run(upload, [version], { FAIL_UPLOAD: "true" })).success);
    assert((await f.run(upload)).success);
    assert(!(await f.run(upload, [version], { FAIL_READ: "true" })).success);
  }));

Deno.test("release downloader verifies and extracts Linux binaries and preserves Windows ZIP", () =>
  withStore(async (f) => {
    assert((await f.run(upload)).success);
    for (
      const platform of ["linux/x86_64", "linux/aarch64", "windows/x86_64"]
    ) {
      const dest = join(f.download, platform);
      const result = await f.run(download, [version, platform, dest]);
      assert(result.success, result.output);
      const windows = platform.startsWith("windows/");
      const name = `swamp-${platform.replace("/", "-")}${
        windows ? ".zip" : ""
      }`;
      assertEquals(
        await Deno.readFile(join(dest, windows ? name : "swamp")),
        await Deno.readFile(join(f.dist, name)),
      );
    }
  }));

Deno.test("release downloader refuses corrupt archives and cloud read failures", () =>
  withStore(async (f) => {
    assert((await f.run(upload)).success);
    const args = [version, "linux/x86_64", f.download];
    assert(!(await f.run(download, args, { FAIL_READ: "true" })).success);
    await Deno.writeTextFile(
      join(f.store, objectKey("linux/x86_64")),
      "corrupt",
    );
    const result = await f.run(download, args);
    assert(!result.success);
    assertStringIncludes(result.output, "mismatched checksum");
    let exists = true;
    try {
      await Deno.stat(f.download);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      exists = false;
    }
    assert(!exists);
  }));

Deno.test("release workflow publishes before UAT and consumers use GCS without GitHub releases", async () => {
  const text = await Deno.readTextFile(
    join(repo, ".github/workflows/release.yml"),
  );
  const workflow = parse(text) as {
    jobs: Record<
      string,
      { steps: { name?: string; run?: string; uses?: string }[] }
    >;
  };
  const steps = workflow.jobs.release.steps;
  const publish = steps.findIndex((s) =>
    s.name === "Upload versioned artifacts to GCS"
  );
  const trigger = steps.findIndex((s) => s.name === "Trigger UAT");
  assert(publish >= 0 && trigger > publish);
  assert(!text.includes("gh release download"));
  assert(!text.includes("action-gh-release"));
  assert(!text.includes("release_body"));
  for (const job of ["windows-smoke", "docker"]) {
    assert(
      workflow.jobs[job].steps.some((s) =>
        s.run?.includes("download_release_artifact.sh")
      ),
    );
  }
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.uses?.startsWith("google-github-actions/")) {
        assert(/@[a-f0-9]{40}$/.test(step.uses));
      }
    }
  }
});
