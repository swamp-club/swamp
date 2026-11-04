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

// Package protocol owns the private serve-engine envelope, not domain payloads.
package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

const Version = 1
const MaxFrameBytes = 8 << 20

var ErrFrame = errors.New("invalid engine frame")
var ErrFrameTooLarge = errors.New("engine frame exceeds size limit")
var ErrVersion = errors.New("incompatible engine protocol version")

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

type Closed struct {
	Code   int    `json:"code"`
	Reason string `json:"reason"`
}

type Envelope struct {
	Version    int             `json:"version"`
	Generation string          `json:"generation"`
	ID         string          `json:"id,omitempty"`
	Method     string          `json:"method,omitempty"`
	Params     json.RawMessage `json:"params,omitempty"`
	Result     json.RawMessage `json:"result,omitempty"`
	Error      *Error          `json:"error,omitempty"`
	SessionID  string          `json:"sessionId,omitempty"`
	Message    json.RawMessage `json:"message,omitempty"`
	Closed     *Closed         `json:"closed,omitempty"`
}

func Read(r io.Reader) (Envelope, error) {
	var e Envelope
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return e, err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n == 0 || n > MaxFrameBytes {
		return e, ErrFrame
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return e, err
	}
	if !utf8.Valid(payload) || json.Unmarshal(payload, &e) != nil {
		return e, ErrFrame
	}
	if e.Version != Version {
		return e, ErrVersion
	}
	if e.Generation == "" {
		return e, ErrFrame
	}
	if e.ID == "" && e.SessionID == "" {
		return e, ErrFrame
	}
	return e, nil
}

// Marshal retains opaque public JSON without HTML escaping, which is unnecessary
// on the private pipe and can otherwise expand a request several times over.
func Marshal(value interface{}) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}

func Encode(e Envelope) ([]byte, error) {
	payload, err := Marshal(e)
	if err != nil {
		return nil, ErrFrame
	}
	if len(payload) > MaxFrameBytes {
		return nil, ErrFrameTooLarge
	}
	frame := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(frame[:4], uint32(len(payload)))
	copy(frame[4:], payload)
	return frame, nil
}

func Write(w io.Writer, frame []byte) error {
	for len(frame) > 0 {
		n, err := w.Write(frame)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		frame = frame[n:]
	}
	return nil
}
