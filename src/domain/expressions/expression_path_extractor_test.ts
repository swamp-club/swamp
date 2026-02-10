import { assertEquals } from "@std/assert";
import {
  extractEnvReferences,
  extractPathReferences,
  extractSelfReferences,
} from "./expression_path_extractor.ts";

// extractPathReferences tests

Deno.test("extractPathReferences extracts simple resource path", () => {
  const refs = extractPathReferences("model.my-vpc.resource.attributes.VpcId");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].modelRef, "my-vpc");
  assertEquals(refs[0].type, "resource");
  assertEquals(refs[0].path, ["attributes", "VpcId"]);
  assertEquals(refs[0].fullPath, "resource.attributes.VpcId");
  assertEquals(refs[0].rawExpression, "model.my-vpc.resource.attributes.VpcId");
});

Deno.test("extractPathReferences extracts simple input path", () => {
  const refs = extractPathReferences("model.my-vpc.input.attributes.CidrBlock");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].modelRef, "my-vpc");
  assertEquals(refs[0].type, "input");
  assertEquals(refs[0].path, ["attributes", "CidrBlock"]);
  assertEquals(refs[0].fullPath, "input.attributes.CidrBlock");
});

Deno.test("extractPathReferences handles path with array index", () => {
  const refs = extractPathReferences(
    "model.vpc.resource.attributes.Tags[0].Key",
  );
  assertEquals(refs.length, 1);
  assertEquals(refs[0].path, ["attributes", "Tags", "0", "Key"]);
  assertEquals(refs[0].fullPath, "resource.attributes.Tags[0].Key");
});

Deno.test("extractPathReferences handles multiple array indices", () => {
  const refs = extractPathReferences("model.vpc.resource.data[0][1].value");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].path, ["data", "0", "1", "value"]);
});

Deno.test("extractPathReferences extracts multiple references", () => {
  const expr =
    "model.vpc.resource.attributes.VpcId + model.subnet.input.attributes.CidrBlock";
  const refs = extractPathReferences(expr);
  assertEquals(refs.length, 2);
  assertEquals(refs[0].modelRef, "vpc");
  assertEquals(refs[0].type, "resource");
  assertEquals(refs[1].modelRef, "subnet");
  assertEquals(refs[1].type, "input");
});

Deno.test("extractPathReferences deduplicates identical references", () => {
  const expr =
    "model.vpc.resource.attributes.VpcId + model.vpc.resource.attributes.VpcId";
  const refs = extractPathReferences(expr);
  assertEquals(refs.length, 1);
});

Deno.test("extractPathReferences handles reference without path", () => {
  const refs = extractPathReferences("model.vpc.resource");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].path, []);
  assertEquals(refs[0].fullPath, "resource");
});

Deno.test("extractPathReferences handles model names with hyphens", () => {
  const refs = extractPathReferences(
    "model.deploy-vpc-123.resource.attributes.id",
  );
  assertEquals(refs.length, 1);
  assertEquals(refs[0].modelRef, "deploy-vpc-123");
});

Deno.test("extractPathReferences handles model names with underscores", () => {
  const refs = extractPathReferences(
    "model.my_vpc_instance.input.attributes.name",
  );
  assertEquals(refs.length, 1);
  assertEquals(refs[0].modelRef, "my_vpc_instance");
});

Deno.test("extractPathReferences returns empty array for no references", () => {
  const refs = extractPathReferences("self.name + 42");
  assertEquals(refs.length, 0);
});

Deno.test("extractPathReferences handles deeply nested paths", () => {
  const refs = extractPathReferences(
    "model.config.input.attributes.settings.network.vpc.cidr",
  );
  assertEquals(refs.length, 1);
  assertEquals(refs[0].path, [
    "attributes",
    "settings",
    "network",
    "vpc",
    "cidr",
  ]);
});

// extractSelfReferences tests

Deno.test("extractSelfReferences extracts simple self reference", () => {
  const refs = extractSelfReferences("self.attributes.VpcId");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].path, ["attributes", "VpcId"]);
  assertEquals(refs[0].fullPath, "attributes.VpcId");
  assertEquals(refs[0].rawExpression, "self.attributes.VpcId");
});

Deno.test("extractSelfReferences handles just self", () => {
  const refs = extractSelfReferences("self");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].path, []);
  assertEquals(refs[0].fullPath, "");
});

Deno.test("extractSelfReferences handles self.name", () => {
  const refs = extractSelfReferences("self.name");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].path, ["name"]);
  assertEquals(refs[0].fullPath, "name");
});

Deno.test("extractSelfReferences handles multiple self references", () => {
  const refs = extractSelfReferences("self.name + self.version");
  assertEquals(refs.length, 2);
  assertEquals(refs[0].path, ["name"]);
  assertEquals(refs[1].path, ["version"]);
});

Deno.test("extractSelfReferences handles array index", () => {
  const refs = extractSelfReferences("self.attributes.Tags[0].Key");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].path, ["attributes", "Tags", "0", "Key"]);
});

Deno.test("extractSelfReferences deduplicates identical references", () => {
  const refs = extractSelfReferences("self.name + self.name");
  assertEquals(refs.length, 1);
});

Deno.test("extractSelfReferences does not match 'myself'", () => {
  const refs = extractSelfReferences("myself.name");
  assertEquals(refs.length, 0);
});

Deno.test("extractSelfReferences returns empty for no self references", () => {
  const refs = extractSelfReferences("model.vpc.input.x");
  assertEquals(refs.length, 0);
});

// extractEnvReferences tests

Deno.test("extractEnvReferences extracts simple env reference", () => {
  const refs = extractEnvReferences("env.HOME");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].variableName, "HOME");
  assertEquals(refs[0].rawExpression, "env.HOME");
});

Deno.test("extractEnvReferences extracts multiple env references", () => {
  const refs = extractEnvReferences("env.HOME + env.USER");
  assertEquals(refs.length, 2);
  assertEquals(refs[0].variableName, "HOME");
  assertEquals(refs[1].variableName, "USER");
});

Deno.test("extractEnvReferences deduplicates identical references", () => {
  const refs = extractEnvReferences("env.HOME + env.HOME");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].variableName, "HOME");
});

Deno.test("extractEnvReferences handles underscores in variable names", () => {
  const refs = extractEnvReferences("env.AWS_REGION");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].variableName, "AWS_REGION");
});

Deno.test("extractEnvReferences handles digits in variable names", () => {
  const refs = extractEnvReferences("env.VAR123");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].variableName, "VAR123");
});

Deno.test("extractEnvReferences handles complex variable names", () => {
  const refs = extractEnvReferences("env.MY_APP_CONFIG_V2");
  assertEquals(refs.length, 1);
  assertEquals(refs[0].variableName, "MY_APP_CONFIG_V2");
});

Deno.test("extractEnvReferences returns empty for no env references", () => {
  const refs = extractEnvReferences("model.vpc.input.x + self.name");
  assertEquals(refs.length, 0);
});

Deno.test("extractEnvReferences does not match 'myenv'", () => {
  const refs = extractEnvReferences("myenv.HOME");
  assertEquals(refs.length, 0);
});

Deno.test("extractEnvReferences handles env mixed with model refs", () => {
  const refs = extractEnvReferences(
    "env.PREFIX + model.vpc.resource.attributes.id",
  );
  assertEquals(refs.length, 1);
  assertEquals(refs[0].variableName, "PREFIX");
});
