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

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/swamp-club/swamp/packages/serve-go/internal/gateway"
)

type pipeListener struct {
	incoming chan net.Conn
	done     chan struct{}
	once     sync.Once
}

func (l *pipeListener) Accept() (net.Conn, error) {
	select {
	case connection := <-l.incoming:
		return connection, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}
func (l *pipeListener) Close() error   { l.once.Do(func() { close(l.done) }); return nil }
func (l *pipeListener) Addr() net.Addr { return &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 9876} }

type deadlineConnection struct {
	net.Conn
	mu            sync.Mutex
	readDeadline  time.Time
	boundedReads  int
	writeDeadline time.Time
	boundedWrites int
	writeStarted  chan struct{}
	writeOnce     sync.Once
	closed        chan struct{}
	closeOnce     sync.Once
}

func (c *deadlineConnection) rememberReadDeadline(deadline time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.readDeadline = deadline
	if !deadline.IsZero() {
		c.boundedReads++
	}
}
func (c *deadlineConnection) SetReadDeadline(deadline time.Time) error {
	c.rememberReadDeadline(deadline)
	return c.Conn.SetReadDeadline(deadline)
}
func (c *deadlineConnection) rememberWriteDeadline(deadline time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.writeDeadline = deadline
	if !deadline.IsZero() {
		c.boundedWrites++
	}
}
func (c *deadlineConnection) SetWriteDeadline(deadline time.Time) error {
	c.rememberWriteDeadline(deadline)
	return c.Conn.SetWriteDeadline(deadline)
}
func (c *deadlineConnection) SetDeadline(deadline time.Time) error {
	c.rememberReadDeadline(deadline)
	c.rememberWriteDeadline(deadline)
	return c.Conn.SetDeadline(deadline)
}
func (c *deadlineConnection) deadlineState() (time.Time, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.readDeadline, c.boundedReads
}
func (c *deadlineConnection) writeDeadlineState() (time.Time, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.writeDeadline, c.boundedWrites
}
func (c *deadlineConnection) Write(data []byte) (int, error) {
	if c.writeStarted != nil {
		c.writeOnce.Do(func() { close(c.writeStarted) })
	}
	return c.Conn.Write(data)
}
func (c *deadlineConnection) Close() error {
	err := c.Conn.Close()
	if c.closed != nil {
		c.closeOnce.Do(func() { close(c.closed) })
	}
	return err
}

// Fire the deadline already installed by net/http without sleeping or asserting
// wall-clock timing. If HTTP cleared it, no timeout may be injected.
func (c *deadlineConnection) expireReadDeadline() (bool, error) {
	deadline, _ := c.deadlineState()
	if deadline.IsZero() {
		return false, nil
	}
	return true, c.Conn.SetReadDeadline(time.Unix(1, 0))
}
func (c *deadlineConnection) expireWriteDeadline() (bool, error) {
	deadline, _ := c.writeDeadlineState()
	if deadline.IsZero() {
		return false, nil
	}
	return true, c.Conn.SetWriteDeadline(time.Unix(1, 0))
}

func httpTestContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}
func awaitHTTPWork(t *testing.T, ctx context.Context, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("expected HTTP work did not complete")
	}
}
func serveHTTPPipe(t *testing.T, handler http.Handler) *pipeListener {
	t.Helper()
	listener := &pipeListener{incoming: make(chan net.Conn, 2), done: make(chan struct{})}
	server := newHTTPServer("127.0.0.1:9876", handler, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	served := make(chan error, 1)
	go func() { served <- server.Serve(gateway.LimitListener(listener, 1)) }()
	t.Cleanup(func() {
		_ = server.Close()
		if err := <-served; !errors.Is(err, http.ErrServerClosed) {
			t.Errorf("HTTP server cleanup: %v", err)
		}
	})
	return listener
}

func TestWithheldHTTPBodyDeadlineReleasesConnectionCapacity(t *testing.T) {
	ctx := httpTestContext(t)
	handled := make(chan struct{})
	public := gateway.New(gateway.Config{}, nil)
	listener := serveHTTPPipe(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		public.ServeHTTP(w, r)
		if r.ContentLength == 1 {
			close(handled)
		}
	}))
	serverConnection, client := net.Pipe()
	observed := &deadlineConnection{Conn: serverConnection}
	t.Cleanup(func() { _ = observed.Close(); _ = client.Close() })
	if deadline, ok := ctx.Deadline(); ok {
		_ = client.SetDeadline(deadline)
	}
	listener.incoming <- observed
	if _, err := io.WriteString(client, "GET /health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	drained := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, client); close(drained) }()
	awaitHTTPWork(t, ctx, handled)
	if fired, err := observed.expireReadDeadline(); !fired || err != nil {
		t.Fatalf("unread HTTP body had no active request deadline: fired=%v err=%v", fired, err)
	}
	awaitHTTPWork(t, ctx, drained)

	// The same one-slot listener must admit a healthy request after the body
	// deadline closes the stalled connection; this checks capacity release.
	assertHealthyRequestAfterRelease(t, ctx, listener)
}

func assertHealthyRequestAfterRelease(t *testing.T, ctx context.Context, listener *pipeListener) {
	t.Helper()
	nextServer, nextClient := net.Pipe()
	t.Cleanup(func() { _ = nextServer.Close(); _ = nextClient.Close() })
	if deadline, ok := ctx.Deadline(); ok {
		_ = nextClient.SetDeadline(deadline)
	}
	listener.incoming <- nextServer
	if _, err := io.WriteString(nextClient, "GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(nextClient), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("released slot rejected healthy request: %d", response.StatusCode)
	}
}

func TestBlockedHTTPWriterDeadlineReleasesConnectionCapacity(t *testing.T) {
	ctx := httpTestContext(t)
	listener := serveHTTPPipe(t, gateway.New(gateway.Config{}, nil))
	serverConnection, client := net.Pipe()
	observed := &deadlineConnection{Conn: serverConnection, writeStarted: make(chan struct{}), closed: make(chan struct{})}
	t.Cleanup(func() { _ = observed.Close(); _ = client.Close() })
	if deadline, ok := ctx.Deadline(); ok {
		_ = client.SetDeadline(deadline)
	}
	listener.incoming <- observed
	if _, err := io.WriteString(client, "GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	// net.Pipe has no output buffer: the response write cannot complete while
	// this peer deliberately performs no reads, matching a saturated TCP buffer.
	awaitHTTPWork(t, ctx, observed.writeStarted)
	if fired, err := observed.expireWriteDeadline(); !fired || err != nil {
		t.Fatalf("blocked HTTP response had no write deadline: fired=%v err=%v", fired, err)
	}
	awaitHTTPWork(t, ctx, observed.closed)
	assertHealthyRequestAfterRelease(t, ctx, listener)
}

func TestWebSocketUpgradeClearsHTTPReadAndWriteDeadlines(t *testing.T) {
	ctx := httpTestContext(t)
	upgraded, finishWork := make(chan struct{}), make(chan struct{})
	completed := make(chan error, 1)
	listener := serveHTTPPipe(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
		if err != nil {
			completed <- err
			return
		}
		defer connection.CloseNow()
		close(upgraded)
		select {
		case <-finishWork:
		case <-ctx.Done():
			completed <- ctx.Err()
			return
		}
		kind, message, err := connection.Read(ctx)
		if err == nil {
			err = connection.Write(ctx, kind, message)
		}
		completed <- err
	}))
	serverConnection, client := net.Pipe()
	observed := &deadlineConnection{Conn: serverConnection}
	t.Cleanup(func() { _ = observed.Close(); _ = client.Close() })
	listener.incoming <- observed
	transport := &http.Transport{DialContext: func(context.Context, string, string) (net.Conn, error) { return client, nil }}
	t.Cleanup(transport.CloseIdleConnections)
	connection, _, err := websocket.Dial(ctx, "ws://localhost/", &websocket.DialOptions{HTTPClient: &http.Client{Transport: transport}, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.CloseNow() })
	awaitHTTPWork(t, ctx, upgraded)
	deadline, configured := observed.deadlineState()
	if configured == 0 || !deadline.IsZero() {
		t.Fatalf("upgrade retained HTTP read deadline: configured=%d deadline=%v", configured, deadline)
	}
	if fired, err := observed.expireReadDeadline(); fired || err != nil {
		t.Fatalf("HTTP deadline could still interrupt upgraded work: %v %v", fired, err)
	}
	writeDeadline, configuredWrites := observed.writeDeadlineState()
	if configuredWrites == 0 || !writeDeadline.IsZero() {
		t.Fatalf("upgrade retained HTTP write deadline: configured=%d deadline=%v", configuredWrites, writeDeadline)
	}
	if fired, err := observed.expireWriteDeadline(); fired || err != nil {
		t.Fatalf("HTTP write deadline could still interrupt upgraded work: %v %v", fired, err)
	}
	close(finishWork)
	message := []byte("accepted work remains observable")
	if err := connection.Write(ctx, websocket.MessageText, message); err != nil {
		t.Fatal(err)
	}
	_, echoed, err := connection.Read(ctx)
	if err != nil || string(echoed) != string(message) {
		t.Fatalf("upgraded stream failed: %s %v", echoed, err)
	}
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(fmt.Errorf("upgraded handler did not finish: %w", ctx.Err()))
	}
}
