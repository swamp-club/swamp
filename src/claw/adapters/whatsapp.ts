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

const logger = getLogger(["swamp", "claw", "whatsapp"]);

export interface WhatsAppAdapterConfig {
  /** Twilio Account SID. */
  readonly accountSid: string;
  /** Twilio Auth Token for signature verification and API calls. */
  readonly authToken: string;
  /** The Twilio WhatsApp sender number (e.g. "whatsapp:+14155238886"). */
  readonly fromNumber: string;
}

/**
 * WhatsApp adapter via Twilio's WhatsApp API.
 *
 * Twilio sends inbound WhatsApp messages as form-urlencoded POST webhooks.
 * This adapter:
 * 1. Validates the X-Twilio-Signature HMAC-SHA1 header
 * 2. Parses the form body into a NormalizedMessage
 * 3. Sends responses via the Twilio Messages API
 *
 * WhatsApp is pure text — no slash commands, no buttons. Users just send
 * messages like "workflow run deploy" or "data search vpc" and get text back.
 */
export function createWhatsAppAdapter(
  config: WhatsAppAdapterConfig,
): PlatformAdapter {
  const twilioApiBase =
    `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
  const authHeader = "Basic " +
    btoa(`${config.accountSid}:${config.authToken}`);

  return {
    platformId: "whatsapp" as PlatformId,

    async verifyRequest(request: Request): Promise<boolean> {
      const signature = request.headers.get("x-twilio-signature");
      if (!signature) return false;

      try {
        const body = await request.text();
        const url = request.url;

        // Parse form params and sort by key for signing
        const params = new URLSearchParams(body);
        const sorted = [...params.entries()].sort(([a], [b]) =>
          a.localeCompare(b)
        );
        const dataString = url +
          sorted.map(([k, v]) => `${k}${v}`).join("");

        // HMAC-SHA1 with auth token
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(config.authToken),
          { name: "HMAC", hash: "SHA-1" },
          false,
          ["sign"],
        );
        const sig = await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(dataString),
        );
        const computed = btoa(
          String.fromCharCode(...new Uint8Array(sig)),
        );

        return computed === signature;
      } catch (err) {
        logger.warn`Twilio signature verification failed: ${err}`;
        return false;
      }
    },

    async parseMessage(request: Request): Promise<NormalizedMessage | null> {
      const body = await request.text();
      const params = new URLSearchParams(body);

      const messageBody = params.get("Body");
      const from = params.get("From"); // "whatsapp:+1234567890"
      const messageSid = params.get("MessageSid");

      if (!messageBody || !from) return null;

      // Extract phone number from "whatsapp:+1234567890"
      const phone = from.replace("whatsapp:", "");
      // Use the sender's number as both the channel and user ID.
      // Replies go back to this same number.
      return {
        platform: "whatsapp",
        channelId: from,
        userId: phone,
        userName: params.get("ProfileName") ?? phone,
        messageId: messageSid ?? crypto.randomUUID(),
        text: messageBody.trim(),
        timestamp: new Date(),
      };
    },

    async sendResponse(
      channelId: string,
      response: CommandResponse,
    ): Promise<void> {
      // Strip markdown bold since WhatsApp uses *bold* natively
      const text = response.text
        .replaceAll("**", "*");

      await sendTwilioMessage(
        twilioApiBase,
        authHeader,
        config.fromNumber,
        channelId,
        text,
      );
    },

    async sendProgress(
      channelId: string,
      update: ProgressUpdate,
    ): Promise<void> {
      await sendTwilioMessage(
        twilioApiBase,
        authHeader,
        config.fromNumber,
        channelId,
        `⏳ ${update.text}`,
      );
    },
  };
}

async function sendTwilioMessage(
  apiUrl: string,
  authHeader: string,
  from: string,
  to: string,
  body: string,
): Promise<void> {
  const formData = new URLSearchParams();
  formData.set("From", from);
  formData.set("To", to);
  formData.set("Body", body);

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formData.toString(),
  });

  if (!res.ok) {
    logger.warn`Twilio send failed (${res.status}): ${await res.text()}`;
  }
}
