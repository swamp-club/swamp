import { z } from "zod";
import { ModelType } from "../../../src/domain/models/model_type.ts";
import { ModelData } from "../../../src/domain/models/model_data.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
} from "../../../src/domain/models/model.ts";
import type { ModelInput } from "../../../src/domain/models/model_input.ts";

/**
 * Schema for Anthropic Claude model input attributes.
 */
const InputAttributesSchema = z.object({
  /** The user prompt to send to Claude */
  prompt: z.string().min(1),
  /** Optional system prompt */
  systemPrompt: z.string().optional(),
  /** Maximum tokens to generate (default: 4096) */
  maxTokens: z.number().int().positive().default(4096),
  /** Model to use (default: claude-sonnet-4-20250514) */
  model: z.string().default("claude-sonnet-4-20250514"),
});

type InputAttributes = z.infer<typeof InputAttributesSchema>;

/**
 * Schema for Anthropic Claude model data attributes.
 */
const DataAttributesSchema = z.object({
  /** The generated response text */
  response: z.string(),
  /** Number of input tokens used */
  inputTokens: z.number().int().nonnegative(),
  /** Number of output tokens generated */
  outputTokens: z.number().int().nonnegative(),
  /** Model used for generation */
  model: z.string(),
  /** Timestamp when generation completed */
  generatedAt: z.string().datetime(),
});

interface ContentBlock {
  type: string;
  text?: string;
}

interface ClaudeResponse {
  content: ContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  model: string;
}

/**
 * Calls the Anthropic Messages API.
 */
async function callClaude(attrs: InputAttributes): Promise<ClaudeResponse> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const messages = [{ role: "user", content: attrs.prompt }];

  const body: {
    model: string;
    max_tokens: number;
    messages: Array<{ role: string; content: string }>;
    system?: string;
  } = {
    model: attrs.model,
    max_tokens: attrs.maxTokens,
    messages,
  };

  if (attrs.systemPrompt) {
    body.system = attrs.systemPrompt;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Anthropic API error: ${response.status} ${response.statusText} - ${errorBody}`,
    );
  }

  return await response.json();
}

/**
 * Execute the generate method.
 */
async function executeGenerate(
  input: ModelInput,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = InputAttributesSchema.parse(input.attributes);
  const result = await callClaude(attrs);

  // Extract text from content blocks
  const responseText = result.content
    .filter((block: ContentBlock) => block.type === "text")
    .map((block: ContentBlock) => block.text ?? "")
    .join("");

  const data = ModelData.create({
    id: input.id,
    attributes: {
      response: responseText,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      model: result.model,
      generatedAt: new Date().toISOString(),
    },
  });

  return { data };
}

/**
 * Anthropic Claude model definition.
 *
 * Calls the Anthropic Messages API to generate text with Claude.
 * Supports system prompts, configurable max tokens, and model selection.
 * Returns the response text and token usage.
 */
export const anthropicClaudeModel = defineModel({
  type: ModelType.create("anthropic/claude"),
  version: 1,
  inputAttributesSchema: InputAttributesSchema,
  dataAttributesSchema: DataAttributesSchema,
  methods: {
    generate: {
      description: "Generate a response using Claude",
      inputAttributesSchema: InputAttributesSchema,
      execute: executeGenerate,
    },
  },
});
