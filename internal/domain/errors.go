package domain

import "errors"

// Typed errors. The presentation layer maps these to user-visible messages;
// nothing below it is allowed to speak UI words (a hard layering rule).
var (
	ErrInvalid      = errors.New("invalid input")
	ErrNotFound     = errors.New("not found")
	ErrUnauthorized = errors.New("authentication failed")
	ErrUnavailable  = errors.New("broker unreachable")
	ErrConflict     = errors.New("conflict")
)
