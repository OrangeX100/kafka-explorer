package decode

// Container decompression for sniffer-labeled payloads: gzip / snappy
// (framed) / lz4 (framed) / zstd — every codec is already in the module
// graph via franz-go, so zero new dependencies.
//
// Guards (the original label-only decision existed to avoid zip-bomb
// style decompression attacks): decompressed output is capped at
// maxDecompressed bytes; anything bigger — or any decompressor error —
// makes ok=false and the caller keeps today's label-only behavior.
// ZIP stays label-only even on success paths: multi-member semantics
// don't fit the single-message decode model.

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"

	"github.com/klauspost/compress/snappy"
	"github.com/klauspost/compress/zstd"
	"github.com/pierrec/lz4/v4"
)

// maxDecompressed caps decompressed payload size (16MB — larger inner
// messages would be unreadable in the detail view anyway).
const maxDecompressed = 16 << 20

// decompressContainer sniffs a compression container and, when the codec
// is one of the safe framed formats, returns the decompressed bytes plus
// the codec name for display. ok=false leaves labeling in charge — that
// includes the cap being hit (the caller cannot distinguish it from an
// unsupported codec, and both mean "keep the label").
func decompressContainer(raw []byte) (out []byte, codec string, ok bool) {
	switch {
	case len(raw) > 2 && raw[0] == 0x1f && raw[1] == 0x8b: // gzip
		return decompressWith(raw, "gzip", func(r io.Reader) (io.Reader, error) {
			return gzip.NewReader(r)
		})
	case len(raw) > 4 && raw[0] == 0x28 && raw[1] == 0xb5 && raw[2] == 0x2f && raw[3] == 0xfd: // zstd
		// zstd errors surface lazily during reads, so this codec reads
		// inline instead of going through decompressWith — and Close only
		// after the bounded read is done (a defer here would close the
		// decoder before any byte was read).
		dz, err := zstd.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, "", false
		}
		out, err := boundedRead(dz)
		dz.Close()
		if err != nil {
			return nil, "", false
		}
		return out, "zstd", true
	case len(raw) > 4 && bytes.HasPrefix(raw, []byte{0x04, 0x22, 0x4d, 0x18}): // lz4 frame
		return decompressWith(raw, "lz4", func(r io.Reader) (io.Reader, error) {
			return lz4.NewReader(r), nil
		})
	case len(raw) > 8 && bytes.HasPrefix(raw, []byte{0xff, 0x06, 0x00, 0x00, 's', 'N', 'a', 'P', 'p', 'Y'}): // snappy framed
		return decompressWith(raw, "snappy", func(r io.Reader) (io.Reader, error) {
			return snappy.NewReader(r), nil
		})
	}
	return nil, "", false
}

// decompressWith runs codec reading under the size cap. Errors (codec
// corrupt, cap exceeded) collapse into ok=false — the payload keeps its
// label and raw bytes either way, so the failure mode is invisible.
func decompressWith(raw []byte, codec string, open func(io.Reader) (io.Reader, error)) ([]byte, string, bool) {
	src := bytes.NewReader(raw)
	r, err := open(src)
	if err != nil {
		return nil, "", false
	}
	out, err := boundedRead(r)
	if err != nil {
		return nil, "", false
	}
	return out, codec, true
}

// boundedRead reads at most maxDecompressed+1 bytes; hitting the cap
// reports an error so the caller falls back instead of carrying a
// truncated decode.
func boundedRead(r io.Reader) ([]byte, error) {
	out, err := io.ReadAll(io.LimitReader(r, maxDecompressed+1))
	if err != nil {
		return nil, err
	}
	if len(out) > maxDecompressed {
		return nil, fmt.Errorf("decompressed payload exceeds %d bytes", maxDecompressed)
	}
	return out, nil
}

// containerNote renders the annotation prepended to a decoded inner
// payload, e.g. "gzip 解压 · 内层 1.2KB".
func containerNote(codec string, inner []byte) string {
	size := len(inner)
	switch {
	case size >= 1<<20:
		return fmt.Sprintf("%s 解压 · 内层 %.1fMB", codec, float64(size)/(1<<20))
	default:
		return fmt.Sprintf("%s 解压 · 内层 %dB", codec, size)
	}
}
