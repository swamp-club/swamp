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

package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
)

const (
	maxResponseBytes = 4 << 20
	maxExcerptBytes  = 500
)

var credentialPattern = regexp.MustCompile(`(sk-[A-Za-z0-9_\-]{8,}|AIza[0-9A-Za-z_\-]{20,}|(?i:bearer)\s+[A-Za-z0-9._\-]{8,})`)

// scrub bounds a diagnostic excerpt and removes the request's own key and
// anything shaped like a credential.
func scrub(text string, secrets ...string) string {
	for _, s := range secrets {
		if s != "" {
			text = strings.ReplaceAll(text, s, "[REDACTED]")
		}
	}
	text = credentialPattern.ReplaceAllString(text, "[REDACTED]")
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > maxExcerptBytes {
		text = text[:maxExcerptBytes] + "…"
	}
	return text
}

type httpCall struct {
	client  *http.Client
	url     string
	headers map[string]string
	body    any
	secret  string
	source  string
}

// do posts the JSON body and decodes a 2xx response into out; every failure
// comes back categorized with a scrubbed, bounded message.
func (c httpCall) do(ctx context.Context, out any) *eval.Error {
	payload, err := json.Marshal(c.body)
	if err != nil {
		return eval.Errorf(eval.ErrConfiguration, "%s: encode request: %v", c.source, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(payload))
	if err != nil {
		return eval.Errorf(eval.ErrConfiguration, "%s: build request: %v", c.source, err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return transportError(ctx, c.source, err, c.secret)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return transportError(ctx, c.source, err, c.secret)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return statusError(c.source, resp.StatusCode, scrub(string(data), c.secret))
	}
	if err := json.Unmarshal(data, out); err != nil {
		return eval.Errorf(eval.ErrBadResponse, "%s: invalid JSON response: %s", c.source, scrub(string(data), c.secret))
	}
	return nil
}

func transportError(ctx context.Context, source string, err error, secret string) *eval.Error {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return eval.Errorf(eval.ErrTimeout, "%s: request timed out", source)
	}
	if errors.Is(err, context.Canceled) {
		return eval.Errorf(eval.ErrCancelled, "%s: request cancelled", source)
	}
	return eval.Errorf(eval.ErrNetwork, "%s: %s", source, scrub(err.Error(), secret))
}

func statusError(source string, status int, excerpt string) *eval.Error {
	category := eval.ErrBadResponse
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		category = eval.ErrAuth
	case status == http.StatusTooManyRequests:
		category = eval.ErrRateLimit
	case status == http.StatusRequestTimeout:
		category = eval.ErrTimeout
	case status >= 500:
		category = eval.ErrProvider
	}
	return eval.Errorf(category, "%s: HTTP %d: %s", source, status, excerpt)
}

func int64Ptr(v int64) *int64 { return &v }

// sumPresent adds the counts the provider reported; nil when none were.
func sumPresent(values ...*int64) *int64 {
	var total *int64
	for _, v := range values {
		if v == nil {
			continue
		}
		if total == nil {
			total = int64Ptr(0)
		}
		*total += *v
	}
	return total
}
