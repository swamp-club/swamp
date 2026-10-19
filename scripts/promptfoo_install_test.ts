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

import { assertEquals } from "@std/assert";
import { libsqlBindingPackage, npmInstallArgs } from "./promptfoo_install.ts";

Deno.test("libsqlBindingPackage: maps supported hosts to libsql's binding packages", () => {
  const cases: [Parameters<typeof libsqlBindingPackage>[0], string][] = [
    [{ os: "linux", arch: "x86_64", env: "gnu" }, "@libsql/linux-x64-gnu"],
    [{ os: "linux", arch: "x86_64", env: "musl" }, "@libsql/linux-x64-musl"],
    [{ os: "linux", arch: "aarch64", env: "gnu" }, "@libsql/linux-arm64-gnu"],
    [{ os: "linux", arch: "aarch64", env: "musl" }, "@libsql/linux-arm64-musl"],
    [{ os: "linux", arch: "x86_64" }, "@libsql/linux-x64-gnu"],
    [{ os: "darwin", arch: "aarch64" }, "@libsql/darwin-arm64"],
    [{ os: "darwin", arch: "x86_64" }, "@libsql/darwin-x64"],
    [{ os: "windows", arch: "x86_64", env: "msvc" }, "@libsql/win32-x64-msvc"],
  ];
  for (const [build, expected] of cases) {
    assertEquals(libsqlBindingPackage(build), expected);
  }
});

Deno.test("libsqlBindingPackage: returns undefined for hosts libsql has no binding for", () => {
  assertEquals(
    libsqlBindingPackage({ os: "windows", arch: "aarch64", env: "msvc" }),
    undefined,
  );
  assertEquals(
    libsqlBindingPackage({ os: "freebsd", arch: "x86_64" }),
    undefined,
  );
  assertEquals(
    libsqlBindingPackage({ os: "linux", arch: "riscv64" }),
    undefined,
  );
});

Deno.test("npmInstallArgs: omits optional deps and ignores the lockfile", () => {
  assertEquals(npmInstallArgs(), [
    "install",
    "--package-lock=false",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
  ]);
});

Deno.test("npmInstallArgs: adds the cache directory when one is given", () => {
  assertEquals(npmInstallArgs({ cacheDir: "/tmp/cache" }).slice(-2), [
    "--cache",
    "/tmp/cache",
  ]);
});

Deno.test("npmInstallArgs: adds packages without saving them", () => {
  assertEquals(
    npmInstallArgs({
      cacheDir: "/tmp/cache",
      packages: ["@libsql/linux-x64-gnu@0.5.29"],
    }).slice(-4),
    ["--cache", "/tmp/cache", "--no-save", "@libsql/linux-x64-gnu@0.5.29"],
  );
  assertEquals(npmInstallArgs({ packages: [] }).includes("--no-save"), false);
});
