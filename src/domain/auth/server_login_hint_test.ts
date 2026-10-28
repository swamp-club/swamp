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

import { assertEquals } from "@std/assert";
import {
  recordWithheldTokenFile,
  resetWithheldTokenFiles,
  serverLoginHint,
} from "./server_login_hint.ts";

Deno.test("serverLoginHint: names server-login with the serve URL as given", () => {
  assertEquals(
    serverLoginHint("wss://serve.example.com"),
    "Authentication failed — run: swamp auth server-login --server wss://serve.example.com",
  );
  assertEquals(
    serverLoginHint("https://serve.example.com:8443"),
    "Authentication failed — run: swamp auth server-login --server https://serve.example.com:8443",
  );
});

Deno.test("serverLoginHint: says the token file was withheld from that serve before the login command", () => {
  resetWithheldTokenFiles();
  try {
    assertEquals(
      recordWithheldTokenFile("https://serve.example.com", "flag-or-env"),
      true,
    );
    assertEquals(
      recordWithheldTokenFile("https://serve.example.com", "env"),
      false,
    );
    assertEquals(
      serverLoginHint("wss://SERVE.example.com:443/"),
      "Authentication failed — SWAMP_SERVER_TOKEN_FILE was not sent to https://serve.example.com because only .swamp.yaml names that address; set SWAMP_SERVE_URL to it or pass --server to send it, or run: swamp auth server-login --server wss://SERVE.example.com:443/",
    );
    assertEquals(
      serverLoginHint("https://other.example.com"),
      "Authentication failed — run: swamp auth server-login --server https://other.example.com",
    );
    assertEquals(
      serverLoginHint("not a url"),
      "Authentication failed — run: swamp auth server-login --server not a url",
    );
  } finally {
    resetWithheldTokenFiles();
  }
});

Deno.test("serverLoginHint: a datastore upstream withheld the token file from names only SWAMP_SERVE_URL", () => {
  resetWithheldTokenFiles();
  try {
    recordWithheldTokenFile("http://serve.test:9090", "env");
    assertEquals(
      serverLoginHint("http://serve.test:9090"),
      "Authentication failed — SWAMP_SERVER_TOKEN_FILE was not sent to http://serve.test:9090 because only .swamp.yaml names that address; set SWAMP_SERVE_URL to it to send it, or run: swamp auth server-login --server http://serve.test:9090",
    );
  } finally {
    resetWithheldTokenFiles();
  }
});
