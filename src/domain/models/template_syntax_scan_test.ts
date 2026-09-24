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
