// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { getLogger } from "@logtape/logtape";
import type { PlatformAdapter } from "../platform_adapter.ts";
import type {
  CommandResponse,
  NormalizedMessage,
  PlatformId,
  ProgressUpdate,
} from "../types.ts";

const logger = getLogger(["swamp", "claw", "discord"]);

// Discord interaction types
const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;

export interface DiscordAdapterConfig {
  /** Discord application public key for signature verification. */
  readonly publicKey: string;
  /** Discord bot token for sending follow-up messages. */
  readonly botToken: string;
  /** Discord application ID for constructing API URLs. */
  readonly applicationId: string;
}

/**
 * Discord webhook adapter using the Interactions API.
 *
 * Discord sends interactions to a registered endpoint. This adapter:
 * 1. Verifies Ed25519 signatures using the Web Crypto API
 * 2. Responds to PING with PONG (Discord verification handshake)
 * 3. Parses slash command interactions into NormalizedMessages
 * 4. Sends responses via the Discord API
 */
export function createDiscordAdapter(
  config: DiscordAdapterConfig,
): PlatformAdapter {
  let cryptoKey: CryptoKey | null = null;

  async function getPublicKey(): Promise<CryptoKey> {
    if (cryptoKey) return cryptoKey;
    const keyBytes = hexToUint8Array(config.publicKey);
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes.buffer as ArrayBuffer,
      { name: "Ed25519", namedCurve: "Ed25519" },
      true,
      ["verify"],
    );
    return cryptoKey;
  }

  return {
    platformId: "discord" as PlatformId,

    async verifyRequest(request: Request): Promise<boolean> {
      const signature = request.headers.get("x-signature-ed25519");
      const timestamp = request.headers.get("x-signature-timestamp");
      if (!signature || !timestamp) return false;

      try {
        const body = await request.text();
        const key = await getPublicKey();
        const message = new TextEncoder().encode(timestamp + body);
        const sig = hexToUint8Array(signature);
        return await crypto.subtle.verify(
          "Ed25519",
          key,
          sig.buffer as ArrayBuffer,
          message.buffer as ArrayBuffer,
        );
      } catch (err) {
        logger.warn`Discord signature verification failed: ${err}`;
        return false;
      }
    },

    async parseMessage(request: Request): Promise<NormalizedMessage | null> {
      const body = await request.json();

      // Handle Discord's verification ping
      if (body.type === INTERACTION_PING) {
        // Return null to signal the server to respond with PONG
        // The server handler checks for this and responds accordingly
        return null;
      }

      // Handle slash commands
      if (body.type === INTERACTION_APPLICATION_COMMAND) {
        const data = body.data;
        const user = body.member?.user ?? body.user;

        // Reconstruct command text from slash command data
        let text = `/${data.name}`;
        if (data.options) {
          for (const opt of data.options) {
            if (opt.type === 1) {
              // Subcommand
              text += ` ${opt.name}`;
              if (opt.options) {
                for (const subOpt of opt.options) {
                  text += ` --${subOpt.name} ${subOpt.value}`;
                }
              }
            } else {
              text += ` --${opt.name} ${opt.value}`;
            }
          }
        }

        return {
          platform: "discord",
          channelId: body.channel_id ?? "",
          userId: user?.id ?? "",
          userName: user?.username ?? "unknown",
          messageId: body.id ?? "",
          text,
          timestamp: new Date(),
        };
      }

      return null;
    },

    async sendResponse(
      channelId: string,
      response: CommandResponse,
    ): Promise<void> {
      const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bot ${config.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: response.text }),
      });

      if (!res.ok) {
        logger.warn`Discord send failed (${res.status}): ${await res.text()}`;
      }
    },

    async sendProgress(
      channelId: string,
      update: ProgressUpdate,
    ): Promise<void> {
      const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bot ${config.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: `_${update.text}_` }),
      });

      if (!res.ok) {
        logger.warn`Discord progress send failed: ${res.status}`;
      }
    },
  };
}

/** Convert a hex string to Uint8Array. */
function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
