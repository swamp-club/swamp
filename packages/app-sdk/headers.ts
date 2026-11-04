// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

/** The dev server and the hub are different origins, both on loopback. */
const DEV_FRAME_ANCESTORS = "http://127.0.0.1:* http://localhost:*";

/** Never `allow-same-origin`, `allow-top-navigation` or `allow-modals`. */
export const APP_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

export interface AppHeaderOptions {
  /** `host[:port]/path/` of the app's files, ending in a slash. */
  readonly appBase: string;
  readonly contentType: string;
  /** Only `swamp app dev` sets this; serve and the hub never do. */
  readonly dev?: AppDevAdditions;
}

export interface AppDevAdditions {
  /** Vite's HMR socket, as a CSP source. */
  readonly hmrSocket: string;
  /** `host[:port]/app-platform/` of the dashboard serving the platform. */
  readonly platformBase: string;
}

/** Where serve answers for the shared app platform, on the app's own host. */
export const APP_PLATFORM_PREFIX = "/app-platform/";

function platformBaseOf(appBase: string): string {
  const slash = appBase.indexOf("/");
  return `${
    slash === -1 ? appBase : appBase.slice(0, slash)
  }${APP_PLATFORM_PREFIX}`;
}

/** `sandbox` is in the CSP so an app URL opened in its own tab stays off the serve origin. */
export function appResponseHeaders(
  options: AppHeaderOptions,
): Record<string, string> {
  const { appBase, contentType, dev } = options;
  // the shared platform is the only code an app runs from outside its files
  const platformBase = dev ? dev.platformBase : platformBaseOf(appBase);
  const scriptSources = dev
    ? `${appBase} ${platformBase} 'unsafe-inline'`
    : `${appBase} ${platformBase}`;
  const connectSources = dev ? `https: wss: ${dev.hmrSocket}` : "https: wss:";
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    // a frame's origin is opaque, so module scripts and fonts are CORS fetches
    "access-control-allow-origin": "*",
    "content-security-policy": [
      // allow-forms: submit events must fire; form-action 'none' stops real submissions
      // allow-popups(-to-escape-sandbox): a link opens as an ordinary new tab, no egress beyond connect-src
      `sandbox ${APP_SANDBOX}`,
      "default-src 'none'",
      "form-action 'none'",
      `script-src ${scriptSources}`,
      `style-src ${appBase} ${platformBase} 'unsafe-inline'`,
      `font-src ${appBase} ${platformBase}`,
      `img-src ${appBase} https: data:`,
      `connect-src ${connectSources}`,
      `frame-ancestors ${dev ? DEV_FRAME_ANCESTORS : "'self'"}`,
    ].join("; "),
  };
}
