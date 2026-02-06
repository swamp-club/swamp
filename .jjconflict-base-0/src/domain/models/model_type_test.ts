import { assertEquals, assertThrows } from "@std/assert";
import { ModelType } from "./model_type.ts";

Deno.test("ModelType.create normalizes AWS-style types", () => {
  const type = ModelType.create("AWS::EC2::VPC");
  assertEquals(type.raw, "AWS::EC2::VPC");
  assertEquals(type.normalized, "aws/ec2/vpc");
  assertEquals(type.toNormalized(), "aws/ec2/vpc");
});

Deno.test("ModelType.create normalizes space-separated types", () => {
  const type = ModelType.create("docker run");
  assertEquals(type.raw, "docker run");
  assertEquals(type.normalized, "docker/run");
});

Deno.test("ModelType.create normalizes dot-separated types", () => {
  const type = ModelType.create("Microsoft.Resources.resourceGroup");
  assertEquals(type.raw, "Microsoft.Resources.resourceGroup");
  assertEquals(type.normalized, "microsoft/resources/resourcegroup");
});

Deno.test("ModelType.create preserves already-normalized types", () => {
  const type = ModelType.create("swamp/echo");
  assertEquals(type.raw, "swamp/echo");
  assertEquals(type.normalized, "swamp/echo");
});

Deno.test("ModelType.create handles mixed separators", () => {
  const type = ModelType.create("Microsoft.Resources/resourceGroup");
  assertEquals(type.normalized, "microsoft/resources/resourcegroup");
});

Deno.test("ModelType.create trims whitespace", () => {
  const type = ModelType.create("  swamp/echo  ");
  assertEquals(type.raw, "swamp/echo");
  assertEquals(type.normalized, "swamp/echo");
});

Deno.test("ModelType.create throws on empty string", () => {
  assertThrows(
    () => ModelType.create(""),
    Error,
    "Model type cannot be empty",
  );
});

Deno.test("ModelType.create throws on whitespace-only string", () => {
  assertThrows(
    () => ModelType.create("   "),
    Error,
    "Model type cannot be empty",
  );
});

Deno.test("ModelType.equals returns true for same normalized types", () => {
  const type1 = ModelType.create("AWS::EC2::VPC");
  const type2 = ModelType.create("aws/ec2/vpc");
  assertEquals(type1.equals(type2), true);
});

Deno.test("ModelType.equals returns false for different types", () => {
  const type1 = ModelType.create("AWS::EC2::VPC");
  const type2 = ModelType.create("swamp/echo");
  assertEquals(type1.equals(type2), false);
});

Deno.test("ModelType.toDirectoryPath returns normalized path", () => {
  const type = ModelType.create("AWS::EC2::VPC");
  assertEquals(type.toDirectoryPath(), "aws/ec2/vpc");
});

Deno.test("ModelType.toString returns raw type", () => {
  const type = ModelType.create("AWS::EC2::VPC");
  assertEquals(type.toString(), "AWS::EC2::VPC");
});
