import { assertEquals } from "@std/assert";
import { getTokenColor, highlightYaml } from "./yaml_highlighter.ts";

Deno.test("yaml_highlighter - getTokenColor returns correct colors", () => {
  assertEquals(getTokenColor("key"), "cyan");
  assertEquals(getTokenColor("string"), "green");
  assertEquals(getTokenColor("number"), "yellow");
  assertEquals(getTokenColor("boolean"), "magenta");
  assertEquals(getTokenColor("null"), "gray");
  assertEquals(getTokenColor("comment"), "gray");
  assertEquals(getTokenColor("text"), "white");
});

Deno.test("yaml_highlighter - highlightYaml handles empty string", () => {
  const result = highlightYaml("");
  assertEquals(result.length, 1);
  assertEquals(result[0].tokens[0].type, "text");
});

Deno.test("yaml_highlighter - highlightYaml handles simple key-value", () => {
  const result = highlightYaml("name: test");
  assertEquals(result.length, 1);

  const tokens = result[0].tokens;
  const keyToken = tokens.find((t) => t.type === "key");
  const valueToken = tokens.find((t) => t.type === "string");

  assertEquals(keyToken?.text, "name");
  assertEquals(valueToken?.text, "test");
});

Deno.test("yaml_highlighter - highlightYaml handles numbers", () => {
  const result = highlightYaml("count: 42");
  assertEquals(result.length, 1);

  const tokens = result[0].tokens;
  const numberToken = tokens.find((t) => t.type === "number");

  assertEquals(numberToken?.text, "42");
});

Deno.test("yaml_highlighter - highlightYaml handles booleans", () => {
  const trueResult = highlightYaml("enabled: true");
  const falseResult = highlightYaml("disabled: false");

  const trueToken = trueResult[0].tokens.find((t) => t.type === "boolean");
  const falseToken = falseResult[0].tokens.find((t) => t.type === "boolean");

  assertEquals(trueToken?.text, "true");
  assertEquals(falseToken?.text, "false");
});

Deno.test("yaml_highlighter - highlightYaml handles null", () => {
  const result = highlightYaml("value: null");

  const nullToken = result[0].tokens.find((t) => t.type === "null");
  assertEquals(nullToken?.text, "null");
});

Deno.test("yaml_highlighter - highlightYaml handles comments", () => {
  const result = highlightYaml("# This is a comment");

  const commentToken = result[0].tokens.find((t) => t.type === "comment");
  assertEquals(commentToken?.text, "# This is a comment");
});

Deno.test("yaml_highlighter - highlightYaml handles indented content", () => {
  const yaml = `jobs:
  - name: build`;

  const result = highlightYaml(yaml);
  assertEquals(result.length, 2);

  // First line: "jobs:" - key
  const firstLineKey = result[0].tokens.find((t) => t.type === "key");
  assertEquals(firstLineKey?.text, "jobs");

  // Second line: "  - name: build" - list item with key-value
  // Note: the key token captures just "name" (without the dash prefix)
  const secondLineTokenTypes = result[1].tokens.map((t) => t.type);
  const hasKey = secondLineTokenTypes.includes("key");
  const hasString = secondLineTokenTypes.includes("string");
  assertEquals(hasKey, true);
  assertEquals(hasString, true);
});

Deno.test("yaml_highlighter - highlightYaml handles quoted strings", () => {
  const singleQuoted = highlightYaml("message: 'hello world'");
  const doubleQuoted = highlightYaml('message: "hello world"');

  const singleToken = singleQuoted[0].tokens.find((t) => t.type === "string");
  const doubleToken = doubleQuoted[0].tokens.find((t) => t.type === "string");

  assertEquals(singleToken?.text, "'hello world'");
  assertEquals(doubleToken?.text, '"hello world"');
});

Deno.test("yaml_highlighter - highlightYaml handles list items without key", () => {
  const result = highlightYaml("  - item1");

  const stringToken = result[0].tokens.find((t) => t.type === "string");
  assertEquals(stringToken?.text, "item1");
});

Deno.test("yaml_highlighter - highlightYaml handles multi-line YAML", () => {
  const yaml = `name: my-workflow
version: 1
enabled: true
description: null
# A comment
jobs:
  - name: build
    steps:
      - name: checkout`;

  const result = highlightYaml(yaml);

  assertEquals(result.length, 9);

  // Verify various line types are handled
  const keyCount =
    result.flatMap((line) => line.tokens.filter((t) => t.type === "key"))
      .length;
  assertEquals(keyCount >= 5, true);
});
