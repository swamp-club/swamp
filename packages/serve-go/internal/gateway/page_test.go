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

package gateway

import (
	"net/http/httptest"
	"testing"
)

func TestClassifyPageDecidesByCarrierAndShapeAlone(t *testing.T) {
	for _, c := range []struct {
		name   string
		header map[string]string
		page   bool
		token  string
		echo   string
	}{
		{"local token header", map[string]string{LocalTokenHeader: "lease"}, true, "lease", ""},
		{"undotted subprotocol", map[string]string{"Sec-WebSocket-Protocol": "bearer.lease"}, true, "lease", "bearer.lease"},
		{"dotted subprotocol is a serve token", map[string]string{"Sec-WebSocket-Protocol": "bearer.name.secret"}, false, "", ""},
		{"authorization is only ever cli", map[string]string{"Authorization": "Bearer lease", "Sec-WebSocket-Protocol": "bearer.lease"}, false, "", ""},
		{"no credential is not a page", map[string]string{}, false, "", ""},
	} {
		r := httptest.NewRequest("GET", "/w/a/", nil)
		for key, value := range c.header {
			r.Header.Set(key, value)
		}
		token, echo, page := classifyPage(r)
		if page != c.page || token != c.token || echo != c.echo {
			t.Fatalf("%s: got %q %q %v", c.name, token, echo, page)
		}
	}
}

func TestGzipFrameUsesTheTypeScriptThreshold(t *testing.T) {
	below := make([]byte, pageLimits.CompressionThresholdBytes-1)
	if _, compressed := gzipFrame(below); compressed {
		t.Fatal("compressed below the threshold")
	}
	at := make([]byte, pageLimits.CompressionThresholdBytes)
	if _, compressed := gzipFrame(at); !compressed {
		t.Fatal("did not compress at the threshold")
	}
}

func TestPageRoutesNeedLeasesAndAPageRouter(t *testing.T) {
	g := New(gatewayConfig(), Single(nil))
	if _, ok := g.pages(); ok {
		t.Fatal("single-repository gateway serves pages")
	}
}
