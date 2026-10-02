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
  type DynamicCodeKind,
  findDynamicCodeExecution,
} from "./dynamic_code_detector.ts";

function kinds(source: string): DynamicCodeKind[] {
  return findDynamicCodeExecution(source).map((f) => f.kind);
}

const FLAGGED: Array<[string, string, DynamicCodeKind]> = [
  ["bare eval call", 'eval("1");', "eval-reference"],
  ["indirect eval", "(0, eval)(src);", "eval-reference"],
  ["globalThis.eval", "globalThis.eval(src);", "eval-reference"],
  ["window.eval", "window.eval(src);", "eval-reference"],
  ["optional globalThis eval", "globalThis?.eval(src);", "eval-reference"],
  ["eval alias", "const e = eval;", "eval-reference"],
  ["shorthand property", "const o = { eval };", "eval-reference"],
  ["parameter pattern key", "function f({ eval: e }) {}", "eval-reference"],
  ["array pattern", "[eval] = [x];", "eval-reference"],
  ["spread", "const o = { ...eval };", "eval-reference"],
  ["ternary operand", "const f = c ? eval : g;", "eval-reference"],
  ["computed object key", "const o = { [eval(src)]: 1 };", "eval-reference"],
  ["template substitution", "const s = `a${eval(src)}b`;", "eval-reference"],
  ["unicode-escaped identifier", "\\u0065val(src);", "eval-reference"],
  ["braced unicode escape", "\\u{65}val(src);", "eval-reference"],
  ["class field initializer", "class A { x = eval(src); }", "eval-reference"],
  ["class static block", "class A { static { eval(src); } }", "eval-reference"],
  [
    "computed eval on any object",
    'globalThis["eval"](src);',
    "eval-computed-access",
  ],
  ["computed Function", 'x["Function"]("a");', "eval-computed-access"],
  [
    "escaped computed key",
    'globalThis["\\x65val"](src);',
    "eval-computed-access",
  ],
  ["template computed key", "globalThis[`eval`](src);", "eval-computed-access"],
  ["optional computed", 'globalThis?.["eval"](src);', "eval-computed-access"],
  ["new Function", 'new Function("return 1");', "function-constructor"],
  ["Function call", 'Function("return 1")();', "function-constructor"],
  ["Function.call", 'Function.call(null, "a");', "function-constructor"],
  ["Function.apply", 'Function.apply(null, ["a"]);', "function-constructor"],
  ["Function alias", "const F = Function;", "function-constructor"],
  ["Function in array", "const fs = [Function];", "function-constructor"],
  ["globalThis.Function", 'globalThis.Function("a");', "function-constructor"],
  [
    "class extending Function",
    "class X extends Function {}",
    "function-constructor",
  ],
  [
    "constructor of a function literal",
    '(function () {}).constructor("a");',
    "constructor-call",
  ],
  [
    "AsyncFunction route",
    'Object.getPrototypeOf(async () => {}).constructor("a");',
    "constructor-call",
  ],
  [
    "constructor via call",
    'fn.constructor.call(null, "a");',
    "constructor-call",
  ],
  ["this.constructor call", "this.constructor(x);", "constructor-call"],
  ["computed constructor call", 'fn["constructor"]("a");', "constructor-call"],
  ["chained global member", "globalThis.self.eval(src);", "eval-reference"],
  ["eval on a cast global", "(globalThis as any).eval(src);", "eval-reference"],
  [
    "Function on a cast global",
    '(window as unknown as W).Function("a");',
    "function-constructor",
  ],
  [
    "eval text in a regex",
    "const r = /a/; const s = /x eval(y)/;",
    "eval-reference",
  ],
];

for (const [name, source, kind] of FLAGGED) {
  Deno.test(`findDynamicCodeExecution: flags ${name}`, () => {
    assertEquals(kinds(source), [kind]);
  });
}

const ADVERSARIAL: Array<[string, string]> = [
  ["labeled block posing as a method", "foo: { eval(src)\n{} }"],
  ["plain block posing as a method", "{ eval(src)\n{} }"],
  ["if block posing as a method", "if (a) { eval(src)\n{} }"],
  ["arrow body posing as a method", "const f = () => { eval(src)\n{} };"],
  ["case block", "switch (a) { case 1: { eval(src); } }"],
  ["return then block via ASI", "function f() { return\n{ eval(src)\n{} } }"],
  ["object method body not followed by a separator", "x = { eval(src) {} ; }"],
  [
    "type keyword split across lines",
    "type\nT = { a: eval(src) };",
  ],
  ["call after a type alias ends", "type T = A\neval(src);"],
  [
    "slash after a function expression",
    "const x = function () {} / eval(src) / 1;",
  ],
  [
    "slash after a named function expression",
    "x = function f() {} / eval(src) / 1;",
  ],
  [
    "slash after an async function expression",
    "x = async function () {} / eval(src) / 1;",
  ],
  ["slash after a class expression", "const y = class {} / eval(src) / 1;"],
  [
    "slash after a typed function expression",
    "x = function (): {a: 1} {} / eval(src) / 1;",
  ],
  ["regex after an if head", "if (a) /'/; eval(src); //'"],
  ["regex after a while head", "while (a) /`/; eval(src); //`"],
  ["regex after a for head", "for (;;) /'/; eval(src); //'"],
  ["generic return type body", "function f(): Promise<void> { eval(src)\n{} }"],
  ["void return type body", "function f(): void { eval(src)\n{} }"],
  [
    "object method with void return type",
    "const o = { m(): void { eval(src)\n{} } };",
  ],
  ["variable named type before as", "const k = type as string, v = eval(src);"],
  ["variable named type before in", "let t = type in o ? a = eval(s) : 0;"],
  [
    "variable named type before instanceof",
    "x = type instanceof Y, v = eval(s);",
  ],
  ["type then a non-declaration", "f(type); type, v = eval(s);"],
  ["variable named type mid-expression", "a = b + type\nfoo = eval(s);"],
];

for (const [name, source] of ADVERSARIAL) {
  Deno.test(`findDynamicCodeExecution: flags ${name}`, () => {
    assertEquals(kinds(source).includes("eval-reference"), true);
  });
}

const BENIGN: Array<[string, string]> = [
  ["member call named eval", "const r = interpreter.eval(ast, ctx);"],
  ["optional member call", "obj?.eval(x);"],
  ["nested member", "a.window.eval(x);"],
  [
    "class method named eval",
    "class Interp { eval(node: string): string { return node; } }",
  ],
  ["class method with modifier", "class A { private eval(x: number) {} }"],
  [
    "class overload signature",
    "class A { eval(x: string): void;\n eval(x: unknown) {} }",
  ],
  ["class field named eval", "class A { eval = 1; }"],
  ["object method", "const o = { eval(x) { return x; } };"],
  [
    "object accessor",
    "const o = { get eval() { return 1; }, async eval2() {} };",
  ],
  ["object key", "const o = { eval: 1, Function: 2 };"],
  ["private method", "this.#eval(x);"],
  ["names ending in eval", "retrieval(x); interval(y); evaluate(z);"],
  ["strings", "const s = \"eval(\" + 'new Function(' + `eval(`;"],
  ["comments", "// eval(x)\n/* new Function(x) */"],
  ["regex literal", "const r = /eval\\(|new Function\\(/;"],
  ["typeof eval", "const ok = typeof eval === 'function';"],
  ["Function parameter type", "function f(cb: Function) {}"],
  ["Function generic argument", "const a: Array<Function> = [];"],
  [
    "Function second generic argument",
    "const m = new Map<string, Function>();",
  ],
  ["Function array type", "const xs: Function[] = [];"],
  ["Function union type", "let f: Function | null = null;"],
  ["Function constraint", "function g<T extends Function>(t: T) {}"],
  ["Function return type", "function g(): Function { return f; }"],
  ["Function cast", "const f = x as Function;"],
  ["instanceof Function", "const ok = x instanceof Function;"],
  ["Function.prototype member", "Function.prototype.toString.call(f);"],
  ["new this.constructor", "const copy = new this.constructor();"],
  ["new member constructor", "const copy = new a.b.constructor();"],
  ["new parenthesized constructor", "const copy = new (x).constructor();"],
  ["constructor comparison", "const same = x.constructor === Object;"],
  ["interface method signature", "interface E { eval(n: Node): Value; }"],
  ["interface extending Function", "interface F extends Function { x: 1 }"],
  ["type alias method signature", "type E = { eval(n: Node): Value };"],
  ["type alias of Function", "type F = Function;"],
  ["exported type alias", "export type E = { eval(n: Node): Value };"],
  ["declared type alias", "declare type F = Function;"],
  [
    "generic type alias",
    "type G<T extends Function> = { eval(t: T): void };",
  ],
  ["type alias after a block", "if (a) { b(); } type F = Function;"],
  ["object after a top-level ternary", "const o = c ? x : { eval: 1 };"],
  [
    "multi-line type alias",
    "type E =\n  | { eval(n: Node): Value }\n  | Function;\nconst x = 1;",
  ],
  ["division", "const q = a / b; const z = c / d;"],
  ["regex after a function declaration", "function f() {}\n/eval\\(/.test(s);"],
  ["regex after a class declaration", "class A {}\n/x/.test(s);"],
  ["regex after for-of", "for (const m of /a/g.exec(s) ?? []) {}"],
  ["division by a variable named of", "const of = 4; const h = of / 2 / x;"],
  ["globalThis member", "globalThis.fetch(url); globalThis?.Deno;"],
  ["globalThis literal key", 'const d = globalThis["Deno"];'],
  ["globalThis feature test", '"Deno" in globalThis && typeof globalThis;'],
  [
    "cast global member",
    "(globalThis as unknown as { setTimeout: T }).setTimeout = fn;",
  ],
  ["non-null global member", "(globalThis!).fetch(url);"],
  ["globalThis alias without eval members", "const g = globalThis as G;"],
  [
    "globalThis argument without eval members",
    "use(globalThis); interp.run(x);",
  ],
  [
    "shared pool on globalThis",
    "(globalThis as Record<string, unknown>)[KEY] ||= new Map();",
  ],
  ["member eval without a global value", "f.eval(m.receiver, y);"],
  [
    "parameter named self",
    "function unsupported(self, type) { throw self.err(type); }\nev.eval(a, b);",
  ],
  ["variable named self", "const self = this;\nev.eval(a, b);"],
  ["regex with escaped eval", "const r = /eval\\(/;"],
  ["regex with member call text", "const r = /x\\.eval(y)/;"],
  [
    "minified cel-js",
    "class Ev{eval(t,n){return t.evaluate(this,t,n)}}" +
    "function g(f,m,y){return f.eval(m.receiver,y)+f.eval(m.arg,y)}",
  ],
];

for (const [name, source] of BENIGN) {
  Deno.test(`findDynamicCodeExecution: allows ${name}`, () => {
    assertEquals(kinds(source), []);
  });
}

Deno.test("findDynamicCodeExecution: reports 1-based line and column", () => {
  const findings = findDynamicCodeExecution(
    "const a = 1;\n  const b = `x\ny`; eval(a);\n\tnew Function(b);",
  );
  assertEquals(findings, [
    { line: 3, column: 5, kind: "eval-reference" },
    { line: 4, column: 6, kind: "function-constructor" },
  ]);
});

Deno.test("findDynamicCodeExecution: flags Function.prototype.constructor", () => {
  assertEquals(kinds('Function.prototype.constructor("a");'), [
    "function-constructor",
    "constructor-call",
  ]);
});

Deno.test("findDynamicCodeExecution: counts CRLF line endings once", () => {
  const findings = findDynamicCodeExecution("a;\r\nb;\r\neval(x);");
  assertEquals(findings, [{ line: 3, column: 1, kind: "eval-reference" }]);
});

Deno.test("findDynamicCodeExecution: unterminated input does not throw", () => {
  for (
    const source of [
      "'unterminated",
      '"unterminated\neval(x)',
      "`unterminated ${",
      "/* unterminated",
      "const r = /unterminated",
      "eval(",
      "\\u",
      "\\u{110000}",
      "#",
      "}}}))]]",
    ]
  ) {
    findDynamicCodeExecution(source);
  }
});

Deno.test("findDynamicCodeExecution: unterminated string ends at the line", () => {
  assertEquals(kinds('const s = "open\neval(x);'), ["eval-reference"]);
});

Deno.test("findDynamicCodeExecution: deep nesting does not overflow", () => {
  const depth = 10_000;
  assertEquals(
    kinds("`${".repeat(depth) + "eval(x)" + "}`".repeat(depth)),
    ["eval-reference"],
  );
  assertEquals(kinds("{".repeat(depth) + "eval(x)" + "}".repeat(depth)), [
    "eval-reference",
  ]);
  assertEquals(kinds("(".repeat(depth) + "eval" + ")".repeat(depth)), [
    "eval-reference",
  ]);
});

Deno.test("findDynamicCodeExecution: a misread slash does not hide later lines", () => {
  assertEquals(kinds("x = a\n/ b / c\neval(src);"), ["eval-reference"]);
});

Deno.test("findDynamicCodeExecution: unicode brace escapes stay linear", () => {
  // Each failed escape looks at most ten characters ahead, so a large run
  // of them completes; the old unbounded search scanned to end of input.
  const source = "\\u{".repeat(200_000) + "eval(x)";
  assertEquals(kinds(source), ["eval-reference"]);
  assertEquals(kinds("'" + "\\u{".repeat(200_000) + "'; eval(x)"), [
    "eval-reference",
  ]);
});

Deno.test("findDynamicCodeExecution: an invalid identifier escape is skipped", () => {
  assertEquals(kinds("\\u eval(x);"), ["eval-reference"]);
  assertEquals(kinds("\\u{110000} eval(x);"), ["eval-reference"]);
});

Deno.test("findDynamicCodeExecution: flags parenthesized global", () => {
  assertEquals(kinds("(globalThis).eval(src);"), ["eval-reference"]);
});

Deno.test("findDynamicCodeExecution: flags binding pattern key", () => {
  assertEquals(kinds("const { eval: e } = globalThis;"), ["eval-reference"]);
});

Deno.test("findDynamicCodeExecution: flags assignment pattern key", () => {
  assertEquals(kinds("({ eval: e } = globalThis);"), ["eval-reference"]);
});

const ALIASED: Array<[string, string]> = [
  ["alias then member eval", "const g = globalThis;\ng.eval(src);"],
  ["cast alias then member eval", "const g = globalThis as any;\ng.eval(src);"],
  [
    "global passed to a helper",
    "function run(o) { return o.eval(src); }\nrun(globalThis);",
  ],
  ["window alias", "const w = window; w.eval(src);"],
  ["self alias", "const s = self; s.Function(src)();"],
  [
    "self passed alongside a self parameter",
    "function f(self) {}\nconst s = self; s.eval(src);",
  ],
  [
    "variable-key index and member eval",
    "const g = (globalThis as any)[k]; g.eval(src);",
  ],
];

for (const [name, source] of ALIASED) {
  Deno.test(`findDynamicCodeExecution: flags ${name}`, () => {
    const found = kinds(source);
    assertEquals(found.includes("global-object-alias"), true);
    assertEquals(found.includes("aliased-eval-member"), true);
  });
}

Deno.test("findDynamicCodeExecution: aliased findings are sorted by position", () => {
  const findings = findDynamicCodeExecution(
    "x.eval(a);\nconst g = globalThis;",
  );
  assertEquals(findings, [
    { line: 1, column: 3, kind: "aliased-eval-member" },
    { line: 2, column: 11, kind: "global-object-alias" },
  ]);
});
