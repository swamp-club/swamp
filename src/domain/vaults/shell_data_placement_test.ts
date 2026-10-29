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
import { placeShellData, shellDialectFor } from "./shell_data_placement.ts";
import { SecretBagRegistry } from "./secret_bag_registry.ts";
import { VaultSecretBag } from "./vault_secret_bag.ts";

/** `before` + `data` + `after`, with the range of `data`. */
function spliced(before: string, data: string, after = "") {
  return {
    command: before + data + after,
    ranges: [[before.length, before.length + data.length] as const],
  };
}

Deno.test("placeShellData: unquoted data becomes one double-quoted reference", () => {
  const { command, ranges } = spliced("echo hello ", "x; touch /tmp/p");
  const placed = placeShellData(command, ranges, [], "posix");
  assertEquals(placed.command, 'echo hello "${__SWAMP_IN_0}"');
  assertEquals(placed.env, { __SWAMP_IN_0: "x; touch /tmp/p" });
  assertEquals(placed.refused, undefined);
  assertEquals(placed.wholeCommandIsData, false);
});

Deno.test("placeShellData: data in each POSIX quoting context gets that context's reference", () => {
  const cases: [string, string, string][] = [
    ['echo "a ', '"', 'echo "a ${__SWAMP_IN_0}"'],
    ["echo 'a ", "'", `echo 'a '"\${__SWAMP_IN_0}"''`],
    ["echo $'a ", "'", `echo $'a '"\${__SWAMP_IN_0}"$''`],
    ["cat <<EOF\n", "\nEOF", "cat <<EOF\n${__SWAMP_IN_0}\nEOF"],
  ];
  for (const [before, after, expected] of cases) {
    const { command, ranges } = spliced(before, "$(id)", after);
    assertEquals(
      placeShellData(command, ranges, [], "posix").command,
      expected,
      before,
    );
  }
});

Deno.test("placeShellData: data in a quoted here-document is refused", () => {
  const { command, ranges } = spliced("cat <<'EOF'\n", "$(id)", "\nEOF");
  const placed = placeShellData(command, ranges, [], "posix");
  assertEquals(
    placed.refused?.where,
    "a here-document with a quoted delimiter",
  );
  assertEquals(placed.command, command);
  assertEquals(placed.env, {});
});

Deno.test("placeShellData: PowerShell double and bare data expand, single quotes are refused", () => {
  const bare = spliced("Write-Output ", "a; calc");
  assertEquals(
    placeShellData(bare.command, bare.ranges, [], "powershell").command,
    'Write-Output "$env:__SWAMP_IN_0"',
  );
  const double = spliced('Write-Output "a ', "$(calc)", '"');
  assertEquals(
    placeShellData(double.command, double.ranges, [], "powershell").command,
    'Write-Output "a $env:__SWAMP_IN_0"',
  );
  const single = spliced("Write-Output 'a ", "x", "'");
  assertEquals(
    placeShellData(single.command, single.ranges, [], "powershell").refused
      ?.where,
    "PowerShell single quotes",
  );
});

Deno.test("placeShellData: a quote in data does not move the context of the authored text after it", () => {
  // The second splice sits in authored double quotes; the first splice's
  // quote character must not make the scanner read it as unquoted.
  const first = "it's";
  const before = "echo ";
  const middle = ' "b ';
  const second = "$(id)";
  const command = before + first + middle + second + '"';
  const ranges = [
    [before.length, before.length + first.length] as const,
    [
      before.length + first.length + middle.length,
      before.length + first.length + middle.length + second.length,
    ] as const,
  ];
  const placed = placeShellData(command, ranges, [], "posix");
  assertEquals(
    placed.command,
    'echo "${__SWAMP_IN_0}" "b ${__SWAMP_IN_1}"',
  );
});

Deno.test("placeShellData: a secret sentinel inside data is left for the secret placement", () => {
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addSecret({ vaultName: "v", key: "k" }, "run");
  const { command, ranges } = spliced("echo ", `a ${sentinel} b`);
  const placed = placeShellData(command, ranges, [], "posix");
  assertEquals(
    placed.command,
    `echo "\${__SWAMP_IN_0}"${sentinel}"\${__SWAMP_IN_1}"`,
  );
  assertEquals(placed.env, { __SWAMP_IN_0: "a ", __SWAMP_IN_1: " b" });
});

Deno.test("placeShellData: generated names skip authored env keys, case-insensitively on PowerShell", () => {
  const { command, ranges } = spliced("echo ", "x");
  assertEquals(
    Object.keys(placeShellData(command, ranges, ["__SWAMP_IN_0"], "posix").env),
    ["__SWAMP_IN_1"],
  );
  assertEquals(
    Object.keys(placeShellData(command, ranges, ["__swamp_in_0"], "posix").env),
    ["__SWAMP_IN_0"],
  );
  assertEquals(
    Object.keys(
      placeShellData(command, ranges, ["__swamp_in_0"], "powershell").env,
    ),
    ["__SWAMP_IN_1"],
  );
});

Deno.test("placeShellData: equal text shares one variable and authored text is unchanged", () => {
  const command = "cp x x";
  const placed = placeShellData(command, [[3, 4], [5, 6]], [], "posix");
  assertEquals(placed.command, 'cp "${__SWAMP_IN_0}" "${__SWAMP_IN_0}"');
  assertEquals(placed.env, { __SWAMP_IN_0: "x" });
});

Deno.test("placeShellData: a command that is nothing but data is reported", () => {
  const placed = placeShellData("  rm -rf /tmp/x ", [[2, 15]], [], "posix");
  assertEquals(placed.wholeCommandIsData, true);
  const partial = placeShellData("echo x", [[5, 6]], [], "posix");
  assertEquals(partial.wholeCommandIsData, false);
});

Deno.test("placeShellData: no ranges leaves the command as it is", () => {
  assertEquals(placeShellData("echo $HOME", [], [], "posix"), {
    command: "echo $HOME",
    env: {},
    wholeCommandIsData: false,
  });
});

Deno.test("shellDialectFor: windows is PowerShell, POSIX hosts are POSIX, others are unknown", () => {
  assertEquals(shellDialectFor("windows"), "powershell");
  assertEquals(shellDialectFor("linux"), "posix");
  assertEquals(shellDialectFor("darwin"), "posix");
  assertEquals(shellDialectFor(""), undefined);
  assertEquals(shellDialectFor("plan9"), undefined);
});
