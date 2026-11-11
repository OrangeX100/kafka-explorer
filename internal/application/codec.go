package application

import "encoding/base64"

func base64Decode(s string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func encodeB64(b []byte) string {
	return base64.StdEncoding.EncodeToString(b)
}
