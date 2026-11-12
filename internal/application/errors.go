package application

import (
	"errors"
	"strings"

	"kafkaexplorer/internal/domain"
)

// ExplainError maps typed domain errors to short user-facing strings.
// Only the presentation layer calls this; services return typed errors.
func ExplainError(err error) string {
	if err == nil {
		return ""
	}
	// SSH tunnel failures first: their raw text is already user-facing
	// Chinese (see infrastructure/kafka/tunnel.go), but the generic
	// auth/unavailable buckets would mangle them.
	msg := err.Error()
	switch {
	case strings.Contains(msg, "SSH 主机指纹发生变化"):
		return msg // MITM guard: surface verbatim, no prefix games
	case strings.Contains(msg, "SSH 连接") && strings.Contains(msg, "失败"):
		return "SSH 跳板机连接失败（检查地址/端口/网络可达性）: " + detailOf(err)
	case strings.Contains(msg, "unable to authenticate") || strings.Contains(msg, "auth failed"):
		return "SSH 认证失败（检查用户名/密码/私钥与口令）"
	case strings.Contains(msg, "SSH 隧道") || strings.Contains(msg, "SSH 私钥"):
		return detailOf(err)
	}
	switch {
	case errors.Is(err, domain.ErrInvalid):
		return "输入无效: " + detailOf(err)
	case errors.Is(err, domain.ErrNotFound):
		return "资源不存在: " + detailOf(err)
	case errors.Is(err, domain.ErrUnauthorized):
		return "认证失败（检查用户名/密码/凭据库）: " + detailOf(err)
	case errors.Is(err, domain.ErrUnavailable):
		return "无法连接到 broker: " + detailOf(err)
	default:
		return detailOf(err)
	}
}

func detailOf(err error) string {
	// The detail is everything after the first ": " chain — errors created
	// with fmt.Errorf("%w: detail") carry it in their text.
	msg := err.Error()
	if i := strings.Index(msg, ": "); i >= 0 {
		return strings.TrimSpace(msg[i+2:])
	}
	return msg
}
