package alist

import (
	"strconv"
)

type ErrorCode uint

const (
	ExpiredTokenError ErrorCode = 401 // {"code":401,"message":"token is expired","data":null}
)

func (c ErrorCode) Error() string {
	switch c {
	case ExpiredTokenError:
		return "token is expired"
	default:
		return "unknown error for code: " + strconv.Itoa(int(c))
	}
}
