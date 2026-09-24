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
  scanTemplateSyntax,
  type TemplateSyntaxFinding,
} from "./template_syntax_scan.ts";

const noInputs = { declaredInputs: new Set<string>() };

function classify(
  value: string,
  declaredInputs: string[] = [],
): "malformed" | "foreign" | "none" {
  const scan = scanTemplateSyntax({ v: value }, {
    declaredInputs: new Set(declaredInputs),
  });
  if (scan.malformed.length > 0) return "malformed";
  if (scan.foreign.length > 0) return "foreign";
  return "none";
}

Deno.test("scanTemplateSyntax: another service's double-brace syntax is foreign", () => {
  for (
    const value of [
      "crashed on {{host.name}}",
      "{{value}} over {{threshold}}",
      "{{#is_alert}}disk full{{/is_alert}}",
      "{{ .Values.env }}",
      "{{ $labels.instance }}",
      "{{my-vpc.VpcId}}",
      "{{ }}",
    ]
  ) {
    assertEquals(classify(value), "foreign", value);
  }
});

Deno.test("scanTemplateSyntax: double braces on a swamp root are malformed", () => {
  for (
    const value of [
      "{{self.name}}",
      "{{ model.my-vpc.resource.vpc.main.attributes.VpcId }}",
      "{{ vault.get('v', 'k') }}",
      "{{ env.HOME }}",
      "{{env.name}}",
      "{{ workflow.name }}",
      "{{ steps.gen.outputs.result }}",
      "{{ data.latest('m', 'd') }}",
      "{{ 1 }}",
      "{{ 'text' }}",
    ]
  ) {
    assertEquals(classify(value), "malformed", value);
  }
});

Deno.test("scanTemplateSyntax: inputs are swamp's only when the definition declares them", () => {
  assertEquals(classify("{{ inputs.env }}", ["env"]), "malformed");
  assertEquals(classify("{{ inputs.env }}"), "foreign");
  assertEquals(classify("{{inputs.parameters.message}}", ["env"]), "foreign");
});

Deno.test("scanTemplateSyntax: single-brace text is classified the same way", () => {
  assertEquals(classify('echo "${HOME}"'), "foreign");
  assertEquals(classify("${VAR:-default}"), "foreign");
  assertEquals(classify("${var.region}"), "foreign");
  assertEquals(classify("${data.aws_ami.ubuntu.id}"), "malformed");
  assertEquals(classify("${self.private_ip}"), "malformed");
  assertEquals(
    classify("${model.my-vpc.resource.attributes.VpcId}"),
    "malformed",
  );
});

Deno.test("scanTemplateSyntax: real swamp expressions are not matched", () => {
  assertEquals(classify("${{ inputs.env }}", ["env"]), "none");
  assertEquals(classify('${{ "{" + "{host.name}" + "}" }}'), "none");
  assertEquals(classify("plain text"), "none");
});

Deno.test("scanTemplateSyntax: double braces inside an expression are malformed, even when declared", () => {
  const value = 'crashed on ${{ "{{host.name}}" }}';
  const expected: TemplateSyntaxFinding[] = [{
    path: "globalArguments.message",
    text: "{{host.name}}",
    form: "inside-expression",
  }];
  const plain = scanTemplateSyntax(
    { globalArguments: { message: value } },
    noInputs,
  );
  assertEquals(plain, { malformed: expected, foreign: [] });

  const declared = scanTemplateSyntax(
    { globalArguments: { message: value } },
    {
      declaredInputs: new Set(),
      isDeclaredForeign: (path) => path === "globalArguments.message",
    },
  );
  assertEquals(declared, { malformed: expected, foreign: [] });
});

function unclosed(value: string): string[] {
  const scan = scanTemplateSyntax({ v: value }, noInputs);
  assertEquals(
    scan.malformed.filter((f) => f.form === "inside-expression"),
    [],
    value,
  );
  return scan.malformed
    .filter((f) => f.form === "unclosed-expression")
    .map((f) => f.text);
}

Deno.test("scanTemplateSyntax: an unclosed expression is reported instead of the {{...}} it runs into", () => {
  const value = "echo ${{ self.name } && docker ps --format '{{.Names}}'";
  const scan = scanTemplateSyntax(
    { methods: { execute: { arguments: { run: value } } } },
    noInputs,
  );
  assertEquals(scan, {
    malformed: [{
      path: "methods.execute.arguments.run",
      text: "${{ self.name } && docker ps --format '{{.Names}}",
      form: "unclosed-expression",
    }],
    foreign: [],
  });
});

Deno.test("scanTemplateSyntax: every shape of an unclosed expression is reported", () => {
  // Swallows a later expression.
  assertEquals(unclosed("echo ${{ self.name } && echo ${{ self.version }}"), [
    "${{ self.name } && echo ${{ self.version }}",
  ]);
  // Runs on to a }} that closes JSON, after a lone } typed for }}.
  assertEquals(unclosed('curl ${{ self.name } -d \'{"a": {"b": 1}}\''), [
    '${{ self.name } -d \'{"a": {"b": 1}}',
  ]);
  // Both braces missing.
  assertEquals(
    unclosed("echo ${{ self.name && docker ps --format '{{.Names}}'"),
    ["${{ self.name && docker ps --format '{{.Names}}"],
  );
  // No }} after it at all: reported to the end of its line.
  assertEquals(unclosed("echo ${{ self.name } && ls"), [
    "${{ self.name } && ls",
  ]);
  assertEquals(unclosed("echo ${{ self.name }\nls -la\n"), [
    "${{ self.name }",
  ]);
  // A lone } after optional syntax.
  assertEquals(unclosed("echo ${{ self.?name } && ls }}"), [
    "${{ self.?name } && ls }}",
  ]);
  // An extra opening brace.
  assertEquals(unclosed("echo ${{{ self.name }}}"), ["${{{ self.name }}"]);
  assertEquals(unclosed("${{{'a': 1}}}"), ["${{{'a': 1}}"]);
});

Deno.test("scanTemplateSyntax: reports a run of unclosed expressions on one line once", () => {
  assertEquals(unclosed("echo ${{ a } ${{ b }"), ["${{ a } ${{ b }"]);
  assertEquals(unclosed("echo ${{ a }\necho ${{ b }"), [
    "${{ a }",
    "${{ b }",
  ]);
});

Deno.test("scanTemplateSyntax: each unclosed expression in a value is reported", () => {
  assertEquals(
    unclosed(
      "${{ self.name } && echo '{{a}}' ; echo ${{ self.version }} ${{ env.X",
    ),
    ["${{ self.name } && echo '{{a}}", "${{ env.X"],
  );
});

Deno.test("scanTemplateSyntax: braces inside an expression that parses are fine", () => {
  for (
    const value of [
      "echo ${{ '{{' }}",
      "${{ {'a': {'b': 1} } }}",
      "${{ '{' + '{host.name}' + '}' }}",
      '${{ "$" + "{{" }}',
      "${{ data.latest('m', 'rec').?attributes.?fmt.orValue('{{') }}",
    ]
  ) {
    assertEquals(classify(value), "none", value);
  }
});

Deno.test("scanTemplateSyntax: a string cut short by }} stays inside-expression", () => {
  const scan = scanTemplateSyntax(
    { v: 'x ${{ "{{a}} and {{b}}" }} ${{ self.name }}' },
    noInputs,
  );
  assertEquals(scan.malformed, [{
    path: "v",
    text: "{{a}}",
    form: "inside-expression",
  }]);
});

Deno.test("scanTemplateSyntax: a string cut short with optional syntax stays inside-expression", () => {
  const scan = scanTemplateSyntax(
    { v: "${{ data.latest('m', 'r').?attributes.?x.orValue('{{a}}') }}" },
    noInputs,
  );
  assertEquals(scan.malformed, [{
    path: "v",
    text: "{{a}}",
    form: "inside-expression",
  }]);
});

Deno.test("scanTemplateSyntax: a cut-short string is reported even when its braces match no {{...}}", () => {
  for (
    const [value, text] of [
      ['x ${{ "${{ github.sha }}" }}', "${{ github.sha }}"],
      ['${{ "{{}}" }}', "{{}}"],
    ]
  ) {
    const scan = scanTemplateSyntax({ v: value }, noInputs);
    assertEquals(scan.malformed, [{
      path: "v",
      text,
      form: "inside-expression",
    }], value);
  }
});

Deno.test("scanTemplateSyntax: closed text that is not CEL passes through", () => {
  for (
    const value of [
      "${{ if eq(parameters.env, 'prod') }}:",
      "${{ each step in parameters.steps }}:",
      "write ${{ ... }} for an expression",
      "${{ fromJSON('{}') }}",
      "${{}}",
    ]
  ) {
    assertEquals(classify(value), "none", value);
  }
});

Deno.test("scanTemplateSyntax: a map literal cut short by its own }} is not reported yet (swamp-club#2492)", () => {
  // Known gap: the span shows no sign of running on, so it passes through as
  // text swamp cannot attribute. A quote- and brace-aware scanner fixes it.
  assertEquals(classify("${{ {'a': {'b': 1}} }}"), "none");
  // Only the first } is checked for a lone brace, so one inside a string
  // hides a later typo.
  assertEquals(classify("${{ 'a}b' + self.name } && ls }}"), "none");
});

Deno.test("scanTemplateSyntax: a cut-short expression with no {{ is reported by its own text", () => {
  // A CEL comment hides the lone }, and a later }} recovers the string.
  const value = "${{ a // }\n + 'x}}' }}";
  const scan = scanTemplateSyntax({ v: value }, noInputs);
  assertEquals(scan.malformed, [{
    path: "v",
    text: "${{ a // }\n + 'x}}",
    form: "inside-expression",
  }]);
});

Deno.test("scanTemplateSyntax: unclosed expressions are reported in a declared field", () => {
  const scan = scanTemplateSyntax(
    { globalArguments: { run: "echo ${{ self.name } && ls" } },
    {
      declaredInputs: new Set(),
      isDeclaredForeign: (path) => path === "globalArguments.run",
    },
  );
  assertEquals(scan.malformed, [{
    path: "globalArguments.run",
    text: "${{ self.name } && ls",
    form: "unclosed-expression",
  }]);
});

Deno.test("scanTemplateSyntax: bounds the closing }} tried for each expression", () => {
  // Past the cap, a string that would recover later counts as unclosed.
  const closers = " }}".repeat(40);
  assertEquals(unclosed("${{ '{{a}}" + closers + "' }}"), [
    "${{ '{{a}}",
  ]);
  // Many unclosed expressions, each followed by many closers, are each
  // reported once.
  const value = "${{ x } {{a}} ".repeat(200) + "}} ".repeat(200);
  assertEquals(unclosed(value).length, 200);
});

Deno.test("scanTemplateSyntax: single-brace text inside an expression is CEL string content", () => {
  assertEquals(classify('${{ "${HOME}" }}'), "none");
  assertEquals(classify('${{ "echo ${HOME}" }} and ${HOME}'), "foreign");
});

Deno.test("scanTemplateSyntax: trims the inner text before classifying", () => {
  assertEquals(classify("{{   self.name   }}"), "malformed");
  assertEquals(classify("{{\thost.name\n}}"), "foreign");
});

Deno.test("scanTemplateSyntax: Handlebars triple braces match their inner pair", () => {
  const scan = scanTemplateSyntax({ v: "{{{body}}}" }, noInputs);
  assertEquals(scan.malformed, []);
  assertEquals(scan.foreign, [{
    path: "v",
    text: "{{body}}",
    form: "bare-double-brace",
  }]);
});

Deno.test("scanTemplateSyntax: reports every match in a string", () => {
  const scan = scanTemplateSyntax(
    { v: "{{host.name}} in {{self.name}} and {{value}}" },
    noInputs,
  );
  assertEquals(scan.foreign.map((f) => f.text), ["{{host.name}}", "{{value}}"]);
  assertEquals(scan.malformed.map((f) => f.text), ["{{self.name}}"]);
});

Deno.test("scanTemplateSyntax: both forms match independently on one value", () => {
  const scan = scanTemplateSyntax(
    { v: "{{host.name}} ${model.x.resource.y}" },
    noInputs,
  );
  assertEquals(scan.foreign, [{
    path: "v",
    text: "{{host.name}}",
    form: "bare-double-brace",
  }]);
  assertEquals(scan.malformed, [{
    path: "v",
    text: "${model.x.resource.y}",
    form: "single-brace",
  }]);
});

Deno.test("scanTemplateSyntax: reports paths through objects and arrays", () => {
  const scan = scanTemplateSyntax({
    globalArguments: { alert: { body: "{{host.name}}" }, tags: ["{{env}}"] },
    methods: { run: { arguments: { cmd: "${HOME}" } } },
  }, noInputs);
  assertEquals(scan.foreign.map((f) => f.path), [
    "globalArguments.alert.body",
    "methods.run.arguments.cmd",
  ]);
  assertEquals(scan.malformed.map((f) => f.path), ["globalArguments.tags[0]"]);
});

Deno.test("scanTemplateSyntax: skips declared foreign template fields entirely", () => {
  const scan = scanTemplateSyntax({
    globalArguments: {
      message: "{{env.name}} {{host.name}}",
      nested: { body: "{{self.name}}" },
      query: "{{host.name}}",
    },
  }, {
    declaredInputs: new Set(),
    isDeclaredForeign: (path) =>
      path === "globalArguments.message" ||
      path.startsWith("globalArguments.nested"),
  });
  assertEquals(scan.malformed, []);
  assertEquals(scan.foreign.map((f) => f.path), ["globalArguments.query"]);
});

Deno.test("scanTemplateSyntax: ignores non-string values", () => {
  const scan = scanTemplateSyntax(
    { a: 1, b: true, c: null, d: [2, { e: false }] },
    noInputs,
  );
  assertEquals(scan, { malformed: [], foreign: [] });
});
