import { assertEquals } from "@std/assert";

/**
 * Regex for matching model exports - same as in generate_model_registry.ts
 */
const MODEL_EXPORT_REGEX = /export\s+const\s+(\w+Model)\s*[=:]/g;

/**
 * Extracts model export names from content, skipping comments.
 */
function extractModelExports(content: string): string[] {
  // Remove single-line comments
  const withoutSingleLineComments = content.replace(/\/\/.*$/gm, "");
  // Remove multi-line comments
  const withoutComments = withoutSingleLineComments.replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  const exports: string[] = [];
  let match;

  while ((match = MODEL_EXPORT_REGEX.exec(withoutComments)) !== null) {
    const name = match[1];
    if (!name.includes("MODEL_TYPE") && !name.includes("_MODEL_")) {
      exports.push(name);
    }
  }

  // Reset regex state
  MODEL_EXPORT_REGEX.lastIndex = 0;

  return exports;
}

Deno.test("extractModelExports - matches standard model export", () => {
  const content = `export const ec2InstanceModel = createModel();`;
  assertEquals(extractModelExports(content), ["ec2InstanceModel"]);
});

Deno.test("extractModelExports - matches typed model export", () => {
  const content = `export const ec2VpcModel: ModelDefinition = {};`;
  assertEquals(extractModelExports(content), ["ec2VpcModel"]);
});

Deno.test("extractModelExports - ignores MODEL_TYPE constants", () => {
  const content = `
export const EC2_INSTANCE_MODEL_TYPE = ModelType.create("AWS::EC2::Instance");
export const ec2InstanceModel = createModel();
`;
  assertEquals(extractModelExports(content), ["ec2InstanceModel"]);
});

Deno.test("extractModelExports - ignores single-line commented exports", () => {
  const content = `
// export const oldModel = deprecated();
export const newModel = createModel();
`;
  assertEquals(extractModelExports(content), ["newModel"]);
});

Deno.test("extractModelExports - ignores multi-line commented exports", () => {
  const content = `
/*
export const commentedOutModel = deprecated();
*/
export const activeModel = createModel();
`;
  assertEquals(extractModelExports(content), ["activeModel"]);
});

Deno.test("extractModelExports - ignores block comment with model", () => {
  const content = `
/**
 * Example: export const exampleModel = ...
 */
export const realModel = createModel();
`;
  assertEquals(extractModelExports(content), ["realModel"]);
});

Deno.test("extractModelExports - handles multiple models in one file", () => {
  const content = `
export const fooModel = createModel();
export const barModel: ModelDefinition = {};
export const BAZ_MODEL_TYPE = ModelType.create("baz");
`;
  assertEquals(extractModelExports(content), ["fooModel", "barModel"]);
});

Deno.test("extractModelExports - handles no models", () => {
  const content = `
export const someUtility = () => {};
export function helper() {}
`;
  assertEquals(extractModelExports(content), []);
});

Deno.test("extractModelExports - handles model with whitespace variations", () => {
  const content = `
export const   spacedModel   =   createModel();
export const tabModel	: ModelDefinition = {};
`;
  assertEquals(extractModelExports(content), ["spacedModel", "tabModel"]);
});
