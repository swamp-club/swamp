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
import {
  type DenoCommandKind,
  findDenoCommandUse,
} from "./deno_command_detector.ts";

function kinds(source: string): DenoCommandKind[] {
  return findDenoCommandUse(source).map((f) => f.kind);
}

const FLAGGED: Array<[string, string, DenoCommandKind[]]> = [
  ["new Deno.Command", 'new Deno.Command("ls");', ["command-reference"]],
  ["optional member", "const C = Deno?.Command;", ["command-reference"]],
  ["bracket key", 'new Deno["Command"]("ls");', ["command-reference"]],
  ["template key", 'new Deno[`Command`]("ls");', ["command-reference"]],
  ["optional bracket key", 'Deno?.["Command"];', ["command-reference"]],
  ["cast receiver", 'new (Deno as any).Command("ls");', ["command-reference"]],
  ["non-null receiver", 'new Deno!.Command("ls");', ["command-reference"]],
  [
    "globalThis.Deno.Command",
    'new globalThis.Deno.Command("ls");',
    ["command-reference"],
  ],
  [
    "computed global Deno",
    'new globalThis["Deno"].Command("ls");',
    ["command-reference"],
  ],
  ["self.Deno.Command", 'new self.Deno.Command("ls");', ["command-reference"]],
  ["stored reference", "const C = Deno.Command;", ["command-reference"]],
  ["passed reference", "run(Deno.Command);", ["command-reference"]],
  ["assigned over", "Deno.Command = fake;", ["command-reference"]],
  ["subclassed", "class C extends Deno.Command {}", ["command-reference"]],
  [
    "multi-line construction",
    'new Deno\n  .Command("ls");',
    ["command-reference"],
  ],
  ["import-equals Command", "import C = Deno.Command;", ["command-reference"]],
  [
    "import-equals global Command",
    "import C = globalThis.Deno.Command;",
    ["command-reference"],
  ],
  ["Deno alias", "const d = Deno;", ["deno-value"]],
  ["global Deno alias", "const d = globalThis.Deno;", ["deno-value"]],
  ["computed global Deno alias", 'const d = globalThis["Deno"];', [
    "deno-value",
  ]],
  ["cast Deno alias", "const d = Deno as any;", ["deno-value"]],
  ["Deno passed", "use(Deno);", ["deno-value"]],
  ["Deno spread", "const o = { ...Deno };", ["deno-value"]],
  ["Deno shorthand property", "const o = { Deno };", ["deno-value"]],
  ["Deno in array", "const xs = [Deno];", ["deno-value"]],
  ["Deno returned", "function f() { return Deno; }", ["deno-value"]],
  ["destructured Command", "const { Command } = Deno;", ["deno-value"]],
  ["renamed Command", "const { Command: C } = Deno;", ["deno-value"]],
  ["rest from Deno", "const { ...rest } = Deno;", ["deno-value"]],
  ["assignment destructuring", "({ Command } = Deno);", ["deno-value"]],
  ["parameter default", "function f({ Command } = Deno) {}", ["deno-value"]],
  ["import-equals Deno", "import D = Deno;", ["deno-value"]],
  ["import-equals global Deno", "import D = globalThis.Deno;", ["deno-value"]],
  ["Deno key off globalThis", "const { Deno: d } = globalThis;", [
    "deno-value",
  ]],
  ["shorthand Deno off self", "const { Deno } = self;", ["deno-value"]],
  [
    "Deno key nested under globalThis.self",
    "const { self: { Deno: d } } = globalThis;",
    ["deno-value"],
  ],
  [
    "Deno key nested two global keys deep",
    "const { window: { self: { Deno } } } = globalThis;",
    ["deno-value"],
  ],
  ["Reflect.get on globalThis", 'Reflect.get(globalThis, "Deno");', [
    "deno-value",
  ]],
  ["computed Deno key", "const f = Deno[name];", ["deno-computed-access"]],
  ["built Deno key", 'Deno["Com" + "mand"];', ["deno-computed-access"]],
  ["exported Deno", "export { Deno };", ["deno-value"]],
];

for (const [name, source, expected] of FLAGGED) {
  Deno.test(`findDenoCommandUse: flags ${name}`, () => {
    assertEquals(kinds(source), expected);
  });
}

const SILENT: Array<[string, string]> = [
  ["line comment", '// new Deno.Command("ls")'],
  ["block comment", '/* new Deno.Command("ls") */'],
  [
    "doc comment",
    "/** Every spawn goes through `Deno.Command(bin, { args })`. */",
  ],
  ["string", 'const s = "new Deno.Command(ls)";'],
  ["template text", 'const s = `new Deno.Command("ls")`;'],
  ["regex", "const r = /Deno.Command\\(/;"],
  ["type annotation", "let c: Deno.Command;"],
  ["type alias", "type C = InstanceType<typeof Deno.Command>;"],
  ["cast target", "const c = x as Deno.Command;"],
  ["interface", "interface I { c: Deno.Command }"],
  ["typeof Deno", 'if (typeof Deno !== "undefined") {}'],
  ["typeof Deno.Command", 'if (typeof Deno.Command === "function") {}'],
  ["in check", 'if ("Command" in Deno) {}'],
  ["other Deno member", "const v = Deno.env.get(name);"],
  ["other Deno call", 'await Deno.readTextFile("a");'],
  ["literal other key", 'Deno["env"].get(name);'],
  ["spread of a Deno member", "const env = { ...Deno.env.toObject() };"],
  ["import-equals other member", "import E = Deno.env;"],
  ["import-equals other global member", "import E = globalThis.Deno.env;"],
  ["declare namespace", "declare namespace Deno { const x: number; }"],
  ["enum named Deno", "enum Deno { A }"],
  ["Command on another object", 'new cli.Command("ls");'],
  ["Command field", "const x = cfg.Command;"],
  ["Command key", "const o = { Command: 1 };"],
  ["bare Command class", 'new Command().name("x");'],
  ["Command import", 'import { Command } from "@cliffy/command";'],
  ["Deno object key", "const o = { Deno: 1 };"],
  ["Deno pattern key off another object", "const { Deno: d } = config;"],
  ["Deno parameter", "function f(Deno: number) { return 1; }"],
  ["Deno import binding", 'import Deno from "./x.ts";'],
  ["Deno class member", "class A { Deno = 1; }"],
  ["Reflect.get without a global", 'Reflect.get(obj, "Deno");'],
  ["type-only import-equals Command", "import type C = Deno.Command;"],
  ["type-only import-equals Deno", "import type D = Deno;"],
  ["re-export from another module", 'export { Deno } from "./x.ts";'],
  ["parameter property", "class A { constructor(private Deno: number) {} }"],
  ["namespace re-export named Deno", 'export * as Deno from "./x.ts";'],
  ["UMD namespace export named Deno", "export as namespace Deno;"],
  [
    "Deno key nested under a non-global key",
    "const { config: { Deno: d } } = globalThis;",
  ],
  [
    "Deno key nested in a pattern from another object",
    "const { self: { Deno: d } } = config;",
  ],
];

for (const [name, source] of SILENT) {
  Deno.test(`findDenoCommandUse: does not flag ${name}`, () => {
    assertEquals(kinds(source), []);
  });
}

Deno.test("findDenoCommandUse: reports the Command token's 1-based line and column", () => {
  const source = 'const a = 1;\n  const c = new Deno.Command("ls");\n';
  assertEquals(findDenoCommandUse(source), [
    { line: 2, column: 22, kind: "command-reference" },
  ]);
});

Deno.test("findDenoCommandUse: a multi-line construction is reported on the Command line", () => {
  const source = 'const c = new Deno\n  .Command("ls");\n';
  assertEquals(findDenoCommandUse(source).map((f) => f.line), [2]);
});

Deno.test("findDenoCommandUse: an alias is reported where Deno is used as a value", () => {
  const source = 'const d = Deno;\nconst c = new d.Command("ls");\n';
  assertEquals(findDenoCommandUse(source), [
    { line: 1, column: 11, kind: "deno-value" },
  ]);
});

Deno.test("findDenoCommandUse: a file that does not parse uses the text check", () => {
  const source =
    'const c = new Deno.Command("ls");\n// Deno.Command( in a comment\n{{{';
  assertEquals(findDenoCommandUse(source), [
    { line: 1, column: 15, kind: "unparsed-text" },
    { line: 2, column: 4, kind: "unparsed-text" },
  ]);
});

Deno.test("findDenoCommandUse: a file that does not parse misses an alias, as the text check did", () => {
  assertEquals(kinds("const d = Deno;\n{{{"), []);
});

Deno.test("findDenoCommandUse: uses the program it is given", () => {
  // A null program means the caller's parse failed: the text check runs.
  assertEquals(
    findDenoCommandUse('// new Deno.Command("ls")', null).map((f) => f.kind),
    ["unparsed-text"],
  );
});

Deno.test("findDenoCommandUse: a CR-only file reports the line the analyzer splits on", () => {
  // Babel counts \r as a line break; lines here are counted by \n alone.
  const source = 'const a = 1;\rnew Deno.Command("ls");\n';
  assertEquals(findDenoCommandUse(source), [
    { line: 1, column: 23, kind: "command-reference" },
  ]);
});

Deno.test("findDenoCommandUse: line breaks Babel reads inside a comment do not move a finding", () => {
  for (const br of ["\r", "\r\n", "\u2028", "\u2029"]) {
    const source = `/*${br}${br}*/ new Deno.Command("ls");\nconst b = 2;\n`;
    const lines = findDenoCommandUse(source).map((f) => f.line);
    assertEquals(lines, [br === "\r\n" ? 3 : 1], JSON.stringify(br));
  }
});

Deno.test("findDenoCommandUse: a U+2028 before a call does not shift later lines", () => {
  const source = 'const a = "x";\u2028const b = 1;\nnew Deno.Command("ls");\n';
  assertEquals(findDenoCommandUse(source).map((f) => f.line), [2]);
});
