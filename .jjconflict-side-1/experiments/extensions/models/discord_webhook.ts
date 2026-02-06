import { z } from "zod";
import { ModelType } from "../../../src/domain/models/model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
} from "../../../src/domain/models/model.ts";
import type { Definition } from "../../../src/domain/definitions/definition.ts";

/**
 * Schema for Discord webhook model input attributes.
 */
const InputAttributesSchema = z.object({
  /** Discord webhook URL (optional - falls back to DISCORD_WEBHOOK_URL env var) */
  webhookUrl: z.string().url().optional(),
  /** Message content (max 2000 characters) */
  content: z.string().min(1).max(2000),
  /** Optional username override */
  username: z.string().max(80).optional(),
  /** Optional avatar URL override */
  avatarUrl: z.string().url().optional(),
});

type InputAttributes = z.infer<typeof InputAttributesSchema>;

/**
 * Sends a message via Discord webhook.
 */
async function sendWebhookMessage(attrs: InputAttributes): Promise<void> {
  // Get webhook URL from attrs or fall back to env var
  const webhookUrl = attrs.webhookUrl || Deno.env.get("DISCORD_WEBHOOK_URL");
  if (!webhookUrl) {
    throw new Error(
      "Discord webhook URL required: provide webhookUrl attribute or set DISCORD_WEBHOOK_URL env var",
    );
  }

  const body: {
    content: string;
    username?: string;
    avatar_url?: string;
  } = {
    content: attrs.content,
  };

  if (attrs.username) {
    body.username = attrs.username;
  }

  if (attrs.avatarUrl) {
    body.avatar_url = attrs.avatarUrl;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Discord webhook error: ${response.status} ${response.statusText} - ${errorBody}`,
    );
  }
}

/**
 * Execute the send method.
 */
async function executeSend(
  definition: Definition,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = InputAttributesSchema.parse(definition.attributes);
  await sendWebhookMessage(attrs);

  const dataAttributes = {
    success: true,
    sentAt: new Date().toISOString(),
    contentLength: attrs.content.length,
  };

  const definitionHash = await definition.computeHash();

  return {
    dataOutputs: [{
      name: `${definition.name}-data`,
      content: new TextEncoder().encode(JSON.stringify(dataAttributes)),
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags: { type: "data" },
        ownerDefinition: {
          definitionHash,
          ownerType: "model-method",
          ownerRef: "send",
        },
      },
    }],
  };
}

/**
 * Discord Webhook model definition.
 *
 * Sends messages to a Discord channel via webhook URL.
 * Supports custom username and avatar overrides.
 * Content is limited to 2000 characters per Discord's limit.
 */
export const discordWebhookModel = defineModel({
  type: ModelType.create("discord/webhook"),
  version: 1,
  inputAttributesSchema: InputAttributesSchema,
  methods: {
    send: {
      description: "Send a message to Discord via webhook",
      inputAttributesSchema: InputAttributesSchema,
      execute: executeSend,
    },
  },
});
