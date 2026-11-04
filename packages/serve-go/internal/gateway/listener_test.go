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

package gateway

import (
	"context"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type acceptResult struct {
	connection net.Conn
	err        error
}

type fixtureListener struct {
	results chan acceptResult
	entered chan struct{}
	done    chan struct{}
	once    sync.Once
	calls   atomic.Int32
}

func newFixtureListener(t *testing.T) *fixtureListener {
	t.Helper()
	listener := &fixtureListener{results: make(chan acceptResult, 4), entered: make(chan struct{}, 4), done: make(chan struct{})}
	t.Cleanup(func() { _ = listener.Close() })
	return listener
}
func (l *fixtureListener) Accept() (net.Conn, error) {
	l.calls.Add(1)
	l.entered <- struct{}{}
	select {
	case result := <-l.results:
		return result.connection, result.err
	case <-l.done:
		return nil, net.ErrClosed
	}
}
func (l *fixtureListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}
func (l *fixtureListener) Addr() net.Addr { return &net.TCPAddr{} }

func fixtureConnection(t *testing.T) net.Conn {
	t.Helper()
	server, peer := net.Pipe()
	t.Cleanup(func() { _ = server.Close(); _ = peer.Close() })
	return server
}
func awaitAccept(t *testing.T, result <-chan acceptResult) acceptResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	select {
	case accepted := <-result:
		return accepted
	case <-ctx.Done():
		t.Fatal("listener failed to complete expected work")
		return acceptResult{}
	}
}

func TestLimitListenerSaturationAndRelease(t *testing.T) {
	inner := newFixtureListener(t)
	inner.results <- acceptResult{connection: fixtureConnection(t)}
	inner.results <- acceptResult{connection: fixtureConnection(t)}
	limited := LimitListener(inner, 1).(*limitedListener)
	t.Cleanup(func() { _ = limited.Close() })
	first, err := limited.Accept()
	if err != nil {
		t.Fatal(err)
	}
	// The accepted socket consumes the only reservation. Check saturation
	// directly so this assertion never depends on goroutine scheduling or sleep.
	select {
	case limited.slots <- struct{}{}:
		t.Fatal("accepted socket did not reserve capacity")
	default:
	}
	second := make(chan acceptResult, 1)
	go func() { connection, err := limited.Accept(); second <- acceptResult{connection, err} }()
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	accepted := awaitAccept(t, second)
	if accepted.err != nil || accepted.connection == nil {
		t.Fatalf("released capacity was unusable: %v", accepted.err)
	}
	if inner.calls.Load() != 2 || len(limited.slots) != 1 {
		t.Fatal("accept reservation accounting changed")
	}
	if err := accepted.connection.Close(); err != nil {
		t.Fatal(err)
	}
	if len(limited.slots) != 0 {
		t.Fatal("closed connections retained capacity")
	}
}

func TestLimitListenerAcceptFailureReleasesReservation(t *testing.T) {
	inner := newFixtureListener(t)
	expected := errors.New("accept fixture failure")
	inner.results <- acceptResult{err: expected}
	inner.results <- acceptResult{connection: fixtureConnection(t)}
	limited := LimitListener(inner, 1).(*limitedListener)
	t.Cleanup(func() { _ = limited.Close() })
	if connection, err := limited.Accept(); connection != nil || !errors.Is(err, expected) {
		t.Fatalf("accept failure changed: connection=%v err=%v", connection, err)
	}
	if len(limited.slots) != 0 {
		t.Fatal("failed accept retained capacity")
	}
	accepted := make(chan acceptResult, 1)
	go func() { connection, err := limited.Accept(); accepted <- acceptResult{connection, err} }()
	next := awaitAccept(t, accepted)
	if next.err != nil || next.connection == nil {
		t.Fatalf("accept did not recover: %v", next.err)
	}
	if err := next.connection.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestLimitedConnectionRepeatedCloseReleasesOnlyOnce(t *testing.T) {
	inner := newFixtureListener(t)
	inner.results <- acceptResult{connection: fixtureConnection(t)}
	limited := LimitListener(inner, 1).(*limitedListener)
	t.Cleanup(func() { _ = limited.Close() })
	connection, err := limited.Accept()
	if err != nil {
		t.Fatal(err)
	}
	closed := make(chan acceptResult, 2)
	for range 2 {
		go func() { closed <- acceptResult{err: connection.Close()} }()
	}
	for range 2 {
		if result := awaitAccept(t, closed); result.err != nil {
			t.Fatal(result.err)
		}
	}
	if len(limited.slots) != 0 {
		t.Fatal("repeated close retained capacity")
	}
	inner.results <- acceptResult{connection: fixtureConnection(t)}
	next, err := limited.Accept()
	if err != nil {
		t.Fatal(err)
	}
	if len(limited.slots) != 1 {
		t.Fatal("repeated close released a future reservation")
	}
	if err := next.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestLimitListenerShutdownUnblocksSaturatedAccept(t *testing.T) {
	inner := newFixtureListener(t)
	inner.results <- acceptResult{connection: fixtureConnection(t)}
	limited := LimitListener(inner, 1).(*limitedListener)
	t.Cleanup(func() { _ = limited.Close() })
	connection, err := limited.Accept()
	if err != nil {
		t.Fatal(err)
	}
	pending := make(chan acceptResult, 1)
	go func() { connection, err := limited.Accept(); pending <- acceptResult{connection, err} }()
	if err := limited.Close(); err != nil {
		t.Fatal(err)
	}
	if err := limited.Close(); err != nil {
		t.Fatal(err)
	}
	result := awaitAccept(t, pending)
	if result.connection != nil || !errors.Is(result.err, net.ErrClosed) {
		t.Fatalf("shutdown did not unblock accept: %v", result.err)
	}
	if inner.calls.Load() != 1 {
		t.Fatal("saturated shutdown entered underlying accept")
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	if len(limited.slots) != 0 {
		t.Fatal("shutdown connection retained capacity")
	}
}

func TestLimitListenerShutdownUnblocksUnderlyingAccept(t *testing.T) {
	inner := newFixtureListener(t)
	limited := LimitListener(inner, 1).(*limitedListener)
	t.Cleanup(func() { _ = limited.Close() })
	pending := make(chan acceptResult, 1)
	go func() { connection, err := limited.Accept(); pending <- acceptResult{connection, err} }()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	select {
	case <-inner.entered:
	case <-ctx.Done():
		t.Fatal("underlying accept did not start")
	}
	if err := limited.Close(); err != nil {
		t.Fatal(err)
	}
	result := awaitAccept(t, pending)
	if result.connection != nil || !errors.Is(result.err, net.ErrClosed) {
		t.Fatalf("shutdown did not unblock inner listener: %v", result.err)
	}
	if len(limited.slots) != 0 {
		t.Fatal("closed accept retained capacity")
	}
}
