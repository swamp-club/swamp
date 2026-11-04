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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { basename, dirname, fromFileUrl, join } from "@std/path";
import {
  type CommandHandler,
  withMockedCommand,
} from "@swamp-club/swamp-testing";
import { assertPathEquals } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { runServeGo } from "./serve_go.ts";

const root = fromFileUrl(new URL("../", import.meta.url));
const moduleDir = join(root, "packages", "serve-go");
const pin = /^golang\s+(\S+)\s*$/m.exec(
  await Deno.readTextFile(join(root, ".tool-versions")),
)![1];

function hostCommands(
  os = "linux",
  arch = "amd64",
  cgo = "1",
): CommandHandler {
  return (_command, args) => ({
    stdout: args[0] === "env"
      ? ({
        GOVERSION: `go${pin}`,
        GOOS: os,
        GOARCH: arch,
        CGO_ENABLED: cgo,
      } as Record<string, string>)[args[1]] ?? ""
      : "",
    code: 0,
  });
}

async function withOutputDirectory(fn: (directory: string) => Promise<void>) {
  const directory = await Deno.makeTempDir({
    prefix: "swamp-serve-driver-test-",
  });
  try {
    await fn(directory);
  } finally {
    await Deno.remove(directory, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

Deno.test("runServeGo: a mismatched or failed Go toolchain probe stops verification", async () => {
  for (
    const output of [
      { stdout: "go0.0.0", code: 0, message: `Expected Go ${pin}` },
      { stdout: "", code: 23, message: "go env failed (23)" },
    ]
  ) {
    const { calls } = await withMockedCommand([output], async () => {
      await assertRejects(() => runServeGo(["check"]), Error, output.message);
    });
    assertEquals(calls.map(({ command, args }) => ({ command, args })), [
      { command: "go", args: ["env", "GOVERSION"] },
    ]);
    assertPathEquals(String(calls[0].cwd), moduleDir);
  }
});

Deno.test("runServeGo: race verification depends on both host support and CGO", async (t) => {
  for (
    const [os, arch, cgo, race] of [
      ["linux", "amd64", "1", true],
      ["linux", "arm64", "1", true],
      ["darwin", "amd64", "1", true],
      ["darwin", "arm64", "1", true],
      ["windows", "amd64", "1", true],
      ["linux", "amd64", "0", false],
      ["windows", "arm64", "1", false],
    ] as const
  ) {
    await t.step(`${os}/${arch} CGO=${cgo}`, async () => {
      const { calls } = await withMockedCommand(
        hostCommands(os, arch, cgo),
        () => runServeGo([]),
      );
      const test = calls.find((call) => call.args[0] === "test")!;
      assertEquals(test.args.includes("-race"), race);
      assert(test.args.includes("-count=1"));
      const build = calls.find((call) => call.args[0] === "build")!;
      const output = build.args[build.args.indexOf("-o") + 1];
      assertEquals(
        basename(output),
        os === "windows" ? "swamp-serve.exe" : "swamp-serve",
      );
      await assertRejects(
        () => Deno.stat(dirname(output)),
        Deno.errors.NotFound,
      );
      assert(
        calls.some((call) =>
          call.args[0] === "mod" && call.args[1] === "verify"
        ),
      );
      assert(calls.some((call) => call.args[0] === "vet"));
      for (const call of calls) assertPathEquals(String(call.cwd), moduleDir);
    });
  }
});

Deno.test("runServeGo: formatting and command failures stop before the build", async (t) => {
  for (
    const [command, firstArg, code, stdout, message] of [
      ["gofmt", "-l", 0, "internal/engine/client.go\n", "Go formatting failed"],
      ["gofmt", "-l", 1, "", "Go formatting failed"],
      ["go", "mod", 17, "", "go mod failed (17)"],
      ["go", "vet", 18, "", "go vet failed (18)"],
      ["go", "test", 19, "", "go test failed (19)"],
    ] as const
  ) {
    await t.step(`${command} ${firstArg} exit ${code}`, async () => {
      const fallback = hostCommands();
      const { calls } = await withMockedCommand(
        (actual, args) =>
          actual === command && args[0] === firstArg
            ? { code, stdout }
            : fallback(actual, args),
        () => assertRejects(() => runServeGo(["check"]), Error, message),
      );
      assertEquals(calls.at(-1)!.command, command);
      assertEquals(calls.at(-1)!.args[0], firstArg);
      assertEquals(calls.some((call) => call.args[0] === "build"), false);
    });
  }
});

Deno.test("runServeGo: a failed host build removes its partially written temporary artifact", async () => {
  const fallback = hostCommands();
  let temporary: string | undefined;
  await withMockedCommand(
    async (command, args) => {
      if (command === "go" && args[0] === "build") {
        const output = args[args.indexOf("-o") + 1];
        temporary = dirname(output);
        await Deno.writeTextFile(output, "partial executable");
        assert((await Deno.stat(output)).isFile);
        return { stdout: "", code: 9 };
      }
      return await fallback(command, args);
    },
    () =>
      assertRejects(() => runServeGo(["check"]), Error, "go build failed (9)"),
  );
  assert(temporary !== undefined);
  await assertRejects(() => Deno.stat(temporary!), Deno.errors.NotFound);
});

Deno.test("runServeGo: release builds five targets and writes the matching experimental pair manifest", async () => {
  await withOutputDirectory(async (directory) => {
    const fallback = hostCommands();
    const { calls } = await withMockedCommand(async (command, args) => {
      if (command === "go" && args[0] === "build") {
        await Deno.writeTextFile(
          args[args.indexOf("-o") + 1],
          "compiled fixture",
        );
      }
      return await fallback(command, args);
    }, () => runServeGo(["release", directory, "v1.2.3", "1234abc"]));
    const builds = calls.filter((call) => call.args[0] === "build");
    assertEquals(builds.map((call) => call.env), [
      { GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" },
      { GOOS: "linux", GOARCH: "arm64", CGO_ENABLED: "0" },
      { GOOS: "darwin", GOARCH: "amd64", CGO_ENABLED: "0" },
      { GOOS: "darwin", GOARCH: "arm64", CGO_ENABLED: "0" },
      { GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
    ]);
    const platforms = [
      "linux-x86_64",
      "linux-aarch64",
      "darwin-x86_64",
      "darwin-aarch64",
      "windows-x86_64.exe",
    ];
    for (const [index, call] of builds.entries()) {
      const output = call.args[call.args.indexOf("-o") + 1];
      assertPathEquals(
        output,
        join(directory, `swamp-serve-${platforms[index]}`),
      );
      assertEquals(await Deno.readTextFile(output), "compiled fixture");
      assert(call.args.includes("-trimpath"));
      assert(call.args.includes("-buildvcs=false"));
      assertEquals(
        call.args[call.args.indexOf("-ldflags") + 1],
        "-s -w -X main.version=v1.2.3 -X main.gitSHA=1234abc",
      );
      assertPathEquals(String(call.cwd), moduleDir);
    }
    const manifest = JSON.parse(
      await Deno.readTextFile(join(directory, "swamp-serve-pair.json")),
    );
    assertEquals(manifest.experimental, true);
    assertEquals(manifest.version, "v1.2.3");
    assertEquals(manifest.engineCommit, "1234abc");
    assertEquals(manifest.platforms, platforms);
    assertEquals(
      manifest.protocol,
      JSON.parse(await Deno.readTextFile(join(moduleDir, "protocol.json"))),
    );
    assertStringIncludes(
      manifest.validation,
      "native runtime and swamp-uat results are separate release gates",
    );
  });
});

Deno.test("runServeGo: failed cross-builds do not claim a complete release pair", async () => {
  await withOutputDirectory(async (directory) => {
    const fallback = hostCommands();
    let built = 0;
    const { calls } = await withMockedCommand(
      (command, args) => {
        if (command === "go" && args[0] === "build" && ++built === 3) {
          return { stdout: "", code: 7 };
        }
        return fallback(command, args);
      },
      () =>
        assertRejects(
          () => runServeGo(["release", directory, "v1.2.3", "1234abc"]),
          Error,
          "go build failed (7)",
        ),
    );
    assertEquals(
      calls.filter((call) => call.args[0] === "build").length,
      3,
    );
    await assertRejects(
      () => Deno.stat(join(directory, "swamp-serve-pair.json")),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("runServeGo: invalid linker values and usage never reach a build", async () => {
  await withOutputDirectory(async (directory) => {
    for (
      const args of [
        ["release", directory, "v1 -X main.injected=value", "1234abc"],
        ["release", directory, "v1.2.3", "1234abc -X main.injected=value"],
        ["release", directory, "v1.2.3"],
        ["check", "extra"],
        ["unknown"],
      ]
    ) {
      const { calls } = await withMockedCommand(
        hostCommands(),
        () => assertRejects(() => runServeGo(args)),
      );
      assertEquals(calls.length, 1);
      assertEquals(calls[0].args, ["env", "GOVERSION"]);
    }
    assertEquals(await Array.fromAsync(Deno.readDir(directory)), []);
  });
});
