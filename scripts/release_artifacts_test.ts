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

// Native Windows launches Git Bash, not the WSL bash shim. Convert script
// arguments and shell environment paths to Git Bash's /c/... spelling.
function bashPath(path: string): string {
  return path.replaceAll("\\", "/").replace(
    /^([a-zA-Z]):\//,
    (_, drive: string) => `/${drive.toLowerCase()}/`,
  );
}

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
    [[ "\u0024{FAIL_UPLOAD:-}" != true ]] || exit 8
    [[ "$*" == *--if-generation-match=0* ]] || exit 92
    target="$FIXTURE_ROOT/store/\u0024{4#gs://swamp-club-artifacts/}"
    [[ ! -e "$target" ]] || exit 1
    mkdir -p "$(dirname "$target")"
    cp "$3" "$target"
elif [[ "$2" == cat ]]; then
    [[ "\u0024{FAIL_READ:-}" != true ]] || exit 7
    cat "$FIXTURE_ROOT/store/\u0024{3#gs://swamp-club-artifacts/}"
else
    exit 93
fi
`;
    await Deno.writeTextFile(join(bin, "gcloud"), mock, { mode: 0o755 });
    await Deno.writeTextFile(
      join(bin, "curl"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FIXTURE_ROOT/calls"
[[ "\u0024{FAIL_READ:-}" != true ]] || exit 7
[[ "$*" != *stable* ]] || exit 90
url=""
output=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        https://artifacts.swamp-club.com/*) url="$1" ;;
        -o) shift; output="$1" ;;
    esac
    shift
done
[[ -n "$url" && -n "$output" ]] || exit 91
cp "$FIXTURE_ROOT/store/\u0024{url#https://artifacts.swamp-club.com/}" "$output"
`,
      { mode: 0o755 },
    );
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
        const windows = Deno.build.os === "windows";
        const bash = windows
          ? join(
            Deno.env.get("ProgramFiles") ?? "C:\\Program Files",
            "Git",
            "bin",
            "bash.exe",
          )
          : "bash";
        const result = await new Deno.Command(bash, {
          args: [
            "-c",
            'umask "$1"; shift; exec bash "$@"',
            "release-test",
            umask,
            bashPath(join(repo, "scripts", script)),
            ...args.map(bashPath),
          ],
          cwd: repo,
          env: {
            PATH: `${bin}${windows ? ";" : ":"}${Deno.env.get("PATH") ?? ""}`,
            FIXTURE_ROOT: bashPath(root),
            BINARIES_DIR: bashPath(dist),
            GCS_BUCKET: "swamp-club-artifacts",
            FAIL_READ: "",
            FAIL_UPLOAD: "",
            DRY_RUN: "false",
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

Deno.test("release dry run packages every variant without cloud access", () =>
  withStore(async (f) => {
    const result = await f.run(upload, [version], { DRY_RUN: "true" });
    assert(result.success, result.output);
    assertEquals(await f.calls(), "");
    assertEquals(result.output.split("Dry run: would upload ").length - 1, 10);
    for (const [, platform] of assets) {
      assertStringIncludes(result.output, objectKey(platform));
    }
    await Deno.writeTextFile(join(f.dist, assets[0][0]), "corrupt");
    assert(!(await f.run(upload, [version], { DRY_RUN: "true" })).success);
    assertEquals(await f.calls(), "");
  }));

Deno.test("release uploader rejects invalid dry-run mode before cloud access", () =>
  withStore(async (f) => {
    assert(!(await f.run(upload, [version], { DRY_RUN: "yes" })).success);
    assertEquals(await f.calls(), "");
  }));

Deno.test("release script paths use Git Bash drive paths on Windows", () => {
  assertEquals(
    bashPath("C:\\Users\\runner\\file.sh"),
    "/c/Users/runner/file.sh",
  );
  assertEquals(bashPath("D:/work/file.sh"), "/d/work/file.sh");
  assertEquals(bashPath("/tmp/file.sh"), "/tmp/file.sh");
  assertEquals(bashPath(version), version);
});

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

Deno.test("release workflow publishes GCS and GitHub assets before UAT", async () => {
  const text = await Deno.readTextFile(
    join(repo, ".github/workflows/release.yml"),
  );
  const workflow = parse(text) as {
    jobs: Record<
      string,
      {
        if?: string;
        needs?: string;
        permissions?: Record<string, string>;
        steps: {
          name?: string;
          run?: string;
          uses?: string;
          with?: Record<string, unknown>;
          if?: string;
          env?: Record<string, string>;
        }[];
      }
    >;
  };
  const steps = workflow.jobs.release.steps;
  // Publishing must depend on immutable event context, never GITHUB_ENV or
  // outputs that branch-controlled build scripts could change.
  const gate =
    "(github.event_name == 'pull_request' && github.event.pull_request.merged == true) || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && !inputs.dry_run)";
  const publisher = workflow.jobs["github-release"];
  assertEquals(workflow.jobs.release.permissions?.contents, "read");
  assertEquals(steps[0].with?.["persist-credentials"], false);
  assertEquals(publisher.permissions?.contents, "write");
  assertEquals(publisher.needs, "release");
  assertEquals(publisher.if, gate);
  assert(
    publisher.steps.every((s) =>
      !s.run && !s.uses?.startsWith("actions/checkout@")
    ),
  );
  for (const step of [...steps, ...publisher.steps]) {
    if (
      step.uses?.startsWith("google-github-actions/") ||
      step.name === "Trigger UAT" ||
      step.name === "Create GitHub Release" ||
      step.name === "Stage GitHub Release assets"
    ) {
      assertEquals(step.if, gate);
    }
  }
  const packaging = steps.find((s) =>
    s.run?.includes("upload_release_artifacts.sh")
  );
  assertEquals(packaging?.env?.DRY_RUN, "${{ !(" + gate + ") }}");
  const publish = steps.findIndex((s) =>
    s.name === "Package release artifacts and optionally upload to GCS"
  );
  const stage = steps.findIndex((s) =>
    s.name === "Stage GitHub Release assets"
  );
  assert(publish >= 0 && stage > publish);
  const trigger = publisher.steps.findIndex((s) => s.name === "Trigger UAT");
  const githubRelease = publisher.steps.findIndex((s) =>
    s.name === "Create GitHub Release"
  );
  assert(githubRelease >= 0 && githubRelease < trigger);
  const release = publisher.steps[githubRelease];
  assertEquals(
    release.with?.tag_name,
    "v${{ needs.release.outputs.version }}",
  );
  assertEquals(release.with?.fail_on_unmatched_files, true);
  const publishedFiles = String(release.with?.files).trim().split("\n");
  assertEquals(
    String(steps[stage].with?.path).trim().split("\n"),
    publishedFiles,
  );
  const checksums = steps.find((s) => s.name === "Create checksums");
  assertEquals(
    checksums?.run?.split("\n")[0],
    `sha256sum ${
      publishedFiles.filter((f) => f !== "dist/checksums.txt")
        .map((f) => f.replace("dist/", "")).join(" ")
    } > checksums.txt`,
  );
  assertEquals(
    String(release.with?.files).trim().split("\n"),
    [
      "dist/swamp-linux-x86_64",
      "dist/swamp-linux-aarch64",
      "dist/swamp-darwin-x86_64",
      "dist/swamp-darwin-aarch64",
      "dist/swamp-windows-x86_64.zip",
      "dist/checksums.txt",
    ],
  );
  assert(!text.includes("gh release download"));
  assert(!text.includes("release_body"));
  for (const job of ["windows-smoke", "docker"]) {
    assertEquals(workflow.jobs[job].if, gate);
    assert(
      !JSON.stringify(workflow.jobs[job]).includes("GCP_SERVICE_ACCOUNT_KEY"),
    );
    assert(
      !workflow.jobs[job].steps.some((s) =>
        s.uses?.startsWith("google-github-actions/")
      ),
    );
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
