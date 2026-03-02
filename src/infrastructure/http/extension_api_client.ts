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

import { UserError } from "../../domain/errors.ts";

/** Metadata sent during push initiation and confirmation. */
export interface PushMetadata {
  name: string;
  version: string;
  description: string;
  dependencies: string[];
  platforms: string[];
  labels: string[];
  repository?: string;
}

/** Response from the initiate push endpoint. */
export interface InitiatePushResult {
  uploadUrl: string;
  s3Key: string;
  extensionId: string;
}

/** Response from the confirm push endpoint. */
export interface ConfirmPushResult {
  extensionId: string;
  name: string;
  version: string;
}

/** Information about the latest published version. */
export interface LatestVersionInfo {
  version: string;
  publishedAt: string;
}

/** Extension metadata. */
export interface ExtensionInfo {
  name: string;
  description: string;
  latestVersion: string;
}

/** Parameters for the extension search endpoint. */
export interface ExtensionSearchParams {
  q?: string;
  namespace?: string;
  platform?: string[];
  label?: string[];
  sort?: "relevance" | "new" | "updated" | "name";
  perPage?: number;
  page?: number;
}

/** A single extension entry in search results. */
export interface ExtensionSearchEntry {
  id: string;
  name: string;
  description: string;
  platforms: string[];
  labels: string[];
  latestVersion: string;
  createdAt: string;
  updatedAt: string;
}

/** Response from the extension search endpoint. */
export interface ExtensionSearchResponse {
  extensions: ExtensionSearchEntry[];
  meta: {
    total: number;
    page: number;
    perPage: number;
  };
}

/**
 * HTTP client for the swamp-club extension registry API.
 *
 * Encapsulates all extension API interactions, following the same pattern
 * as SwampClubClient for auth operations.
 */
export class ExtensionApiClient {
  constructor(private readonly serverUrl: string) {}

  /**
   * Pre-flight: check latest published version.
   * Returns null if the extension has never been published.
   */
  async getLatestVersion(
    name: string,
    apiKey?: string,
  ): Promise<LatestVersionInfo | null> {
    const encodedName = encodeURIComponent(name);
    const headers = apiKey ? this.authHeaders(apiKey) : {};
    const res = await this.fetch(
      `/api/v1/extensions/${encodedName}/latest`,
      {
        method: "GET",
        headers,
      },
    );

    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }

    await this.checkResponse(res);
    const data = await res.json();
    return {
      version: data.latestVersionDetail?.version ?? data.latestVersion,
      publishedAt: data.latestVersionDetail?.publishedAt ?? "",
    };
  }

  /**
   * Phase 1: Initiate push — validate metadata and get presigned S3 upload URL.
   */
  async initiatePush(
    metadata: PushMetadata,
    apiKey: string,
  ): Promise<InitiatePushResult> {
    const res = await this.fetch("/api/v1/extensions/push", {
      method: "POST",
      headers: {
        ...this.authHeaders(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metadata),
    });

    await this.checkResponse(res);
    const data = await res.json();
    return {
      uploadUrl: data.uploadUrl,
      s3Key: data.s3Key,
      extensionId: data.extensionId,
    };
  }

  /**
   * Phase 2: Upload tar.gz archive directly to S3 presigned URL.
   */
  async uploadArchive(
    uploadUrl: string,
    archiveBytes: Uint8Array,
  ): Promise<void> {
    try {
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/gzip" },
        body: archiveBytes as unknown as BodyInit,
        signal: AbortSignal.timeout(120_000), // 2 min for upload
      });

      if (!res.ok) {
        const body = await res.text();
        throw new UserError(
          `Failed to upload archive (HTTP ${res.status}): ${body}`,
        );
      }
      await res.body?.cancel();
    } catch (error) {
      if (error instanceof UserError) throw error;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new UserError("Archive upload timed out.");
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(`Archive upload failed: ${message}`);
    }
  }

  /**
   * Phase 3: Confirm push — verify upload completed and persist version.
   */
  async confirmPush(
    metadata: PushMetadata,
    apiKey: string,
  ): Promise<ConfirmPushResult> {
    const res = await this.fetch("/api/v1/extensions/confirm", {
      method: "POST",
      headers: {
        ...this.authHeaders(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metadata),
    });

    await this.checkResponse(res);
    const data = await res.json();
    return {
      extensionId: data.extensionId,
      name: data.name,
      version: data.version,
    };
  }

  /**
   * Search extensions using the structured search endpoint.
   */
  async searchExtensions(
    params: ExtensionSearchParams,
  ): Promise<ExtensionSearchResponse> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.namespace) qs.set("namespace", params.namespace);
    if (params.sort) qs.set("sort", params.sort);
    if (params.perPage !== undefined) {
      qs.set("perPage", String(params.perPage));
    }
    if (params.page !== undefined) qs.set("page", String(params.page));
    for (const p of params.platform ?? []) qs.append("platform", p);
    for (const l of params.label ?? []) qs.append("label", l);

    const query = qs.toString();
    const path = `/api/v1/extensions/search${query ? `?${query}` : ""}`;

    const res = await this.fetch(path, { method: "GET" });
    await this.checkResponse(res);
    return await res.json();
  }

  /**
   * Get extension metadata by name.
   * Returns null if not found.
   */
  async getExtension(
    name: string,
    apiKey?: string,
  ): Promise<ExtensionInfo | null> {
    const encodedName = encodeURIComponent(name);
    const headers = apiKey ? this.authHeaders(apiKey) : {};
    const res = await this.fetch(`/api/v1/extensions/${encodedName}`, {
      method: "GET",
      headers,
    });

    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }

    await this.checkResponse(res);
    return await res.json();
  }

  /**
   * Get download URL for a specific version.
   * Returns null if not found.
   */
  async getDownloadUrl(
    name: string,
    version: string,
    apiKey?: string,
  ): Promise<string | null> {
    const encodedName = encodeURIComponent(name);
    const headers = apiKey ? this.authHeaders(apiKey) : {};
    const res = await this.fetch(
      `/api/v1/extensions/${encodedName}@${version}/download`,
      {
        method: "GET",
        redirect: "manual",
        headers,
      },
    );

    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }

    if (res.status === 302 || res.status === 301) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      return location;
    }

    await this.checkResponse(res);
    return null;
  }

  /**
   * Download the extension archive for a specific version.
   * Returns the raw archive bytes.
   */
  async downloadArchive(
    name: string,
    version: string,
    apiKey?: string,
  ): Promise<Uint8Array> {
    const downloadUrl = await this.getDownloadUrl(name, version, apiKey);
    if (!downloadUrl) {
      throw new UserError(
        `Extension ${name}@${version} not found in the registry.`,
      );
    }
    try {
      const res = await fetch(downloadUrl, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        throw new UserError(
          `Failed to download extension archive (HTTP ${res.status}).`,
        );
      }
      return new Uint8Array(await res.arrayBuffer());
    } catch (error) {
      if (error instanceof UserError) throw error;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new UserError("Extension download timed out.");
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(`Extension download failed: ${message}`);
    }
  }

  /**
   * Fetch the SHA-256 checksum for a specific extension version.
   * Returns null if the extension predates checksum support (legacy) or is not found.
   */
  async getChecksum(
    name: string,
    version: string,
  ): Promise<string | null> {
    const encodedName = encodeURIComponent(name);
    const res = await this.fetch(
      `/api/v1/extensions/${encodedName}@${version}/checksum`,
      {
        method: "GET",
      },
    );

    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }

    await this.checkResponse(res);
    const data = await res.json();
    return data.checksum ?? null;
  }

  private authHeaders(apiKey: string): Record<string, string> {
    return { "Authorization": `Bearer ${apiKey}` };
  }

  private async checkResponse(res: Response): Promise<void> {
    if (res.ok || res.status === 201) return;

    const body = await res.text();

    if (res.status === 401) {
      throw new UserError(
        "Not authenticated. Run 'swamp auth login' first.",
      );
    }

    // Parse error message from server if available
    let serverMessage = body;
    const contentType = res.headers.get("content-type") ?? "";
    if (
      contentType.includes("text/html") || body.trimStart().startsWith("<!")
    ) {
      // Server returned an HTML error page — extract nothing useful
      serverMessage =
        "The server returned an unexpected HTML response. This usually means the API endpoint is unavailable or misconfigured. Try again later.";
    } else {
      try {
        const parsed = JSON.parse(body);
        if (parsed.message) serverMessage = parsed.message;
        if (parsed.error) serverMessage = parsed.error;
      } catch {
        // Use raw body
      }
    }

    if (res.status === 403) {
      throw new UserError(serverMessage);
    }

    if (res.status === 409) {
      throw new UserError(serverMessage);
    }

    if (res.status === 422) {
      throw new UserError(serverMessage);
    }

    throw new UserError(
      `Extension API error (HTTP ${res.status}): ${serverMessage}`,
    );
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.serverUrl}${path}`;
    try {
      return await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (error instanceof UserError) throw error;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new UserError(
          `Request to ${this.serverUrl} timed out. Is the server running?`,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(
        `Could not connect to ${this.serverUrl}: ${message}`,
      );
    }
  }
}
