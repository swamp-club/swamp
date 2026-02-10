import { parse as parseYaml } from "@std/yaml";

/**
 * Result of parsing inputs.
 */
export interface ParsedInputs {
  inputs: Record<string, unknown>;
  source: "json" | "yaml-file" | "none";
}

/**
 * Parses input values from CLI options.
 *
 * @param options - CLI options containing input or inputFile
 * @returns Parsed inputs and their source
 */
export async function parseInputs(options: {
  input?: string;
  inputFile?: string;
}): Promise<ParsedInputs> {
  // --input takes precedence over --input-file
  if (options.input) {
    try {
      const parsed = JSON.parse(options.input);
      if (
        typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      ) {
        throw new Error("Input must be a JSON object");
      }
      return {
        inputs: parsed as Record<string, unknown>,
        source: "json",
      };
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in --input: ${error.message}`);
      }
      throw error;
    }
  }

  if (options.inputFile) {
    try {
      const content = await Deno.readTextFile(options.inputFile);
      const parsed = parseYaml(content);
      if (
        typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      ) {
        throw new Error("Input file must contain a YAML object");
      }
      return {
        inputs: parsed as Record<string, unknown>,
        source: "yaml-file",
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(`Input file not found: ${options.inputFile}`);
      }
      throw error;
    }
  }

  return {
    inputs: {},
    source: "none",
  };
}
