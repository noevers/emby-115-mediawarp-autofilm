package handler

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path"
	"strconv"

	"github.com/AkimioJR/MediaWarp/constants"
	"github.com/AkimioJR/MediaWarp/internal/config"
	"github.com/AkimioJR/MediaWarp/internal/logging"
	"github.com/AkimioJR/MediaWarp/static"
)

// 通用的 Web 响应修改器生成器
func generateWebModifier(t constants.MediaServerType) func(rw *http.Response) error {
	var buff bytes.Buffer
	buff.WriteString("<head>")
	enable := addExternalHeader(config.Web, t, &buff)
	addHeader := buff.Bytes()
	buff.Reset() // 重置缓冲区，释放内存

	return func(rw *http.Response) error {
		var (
			htmlFilePath string = path.Join(config.CostomDir(), "index.html")
			htmlContent  []byte
			err          error
		)

		defer rw.Body.Close() // 无论哪种情况，最终都要确保原 Body 被关闭，避免内存泄漏
		if config.Web.Index { // 从本地文件读取index.html
			if htmlContent, err = os.ReadFile(htmlFilePath); err != nil {
				logging.Warning("读取文件内容出错，错误信息：", err)
				return err
			}
		} else { // 从上游获取响应体
			if htmlContent, err = io.ReadAll(rw.Body); err != nil {
				return err
			}
		}

		if enable { // 将添加HEAD内容插入到<head>标签后面
			htmlContent = bytes.Replace(htmlContent, []byte("<head>"), addHeader, 1)
		}

		rw.Header.Set("Content-Length", strconv.Itoa(len(htmlContent)))
		rw.Body = io.NopCloser(bytes.NewReader(htmlContent))
		return nil
	}
}

func addExternalHeader(cfg config.WebSetting, t constants.MediaServerType, buff *bytes.Buffer) bool {
	if !cfg.Enable {
		logging.Info("Web 功能未启用，未生成外部请求头")
		return false
	}

	var enables [2]bool

	if cfg.Head != "" {
		var b bytes.Buffer

		b.WriteString(static.WebCustomHeaderStart)
		b.WriteString("\n")
		b.WriteString(cfg.Head)
		b.WriteString("\n")
		b.WriteString(static.WebCustomHeaderEnd)
		b.WriteString("\n")

		if _, err := buff.WriteString(b.String()); err != nil {
			logging.Errorf("写入自定义 HEAD 内容到外部请求头失败: %v", err)
			return false
		}

		logging.Infof("Web 配置中自定义了 HEAD 内容，已添加到外部请求头中: %s", b.String())
		enables[0] = true
	}

	enables[1] = addEmbededHeader(cfg, t, buff)

	for _, v := range enables {
		if v {
			return true
		}
	}
	logging.Info("Web 配置中未启用自定义 HEAD 或嵌入脚本功能，未生成外部请求头")
	return false
}

func addEmbededHeader(cfg config.WebSetting, t constants.MediaServerType, buff *bytes.Buffer) bool {
	var b bytes.Buffer
	b.WriteString(static.WebEmbededHeaderStart)
	b.WriteString("\n")

	var enables [6]bool

	enables[0] = addExternalPlayerUrlHeader(cfg.ExternalPlayerUrl, t, &b)
	enables[1] = addCrxHeader(cfg.Crx, t, &b)
	enables[2] = addDanmakuHeader(cfg.Danmaku, t, &b)
	enables[3] = addActorPlusHeader(cfg.ActorPlus, t, &b)
	enables[4] = addFanartShowHeader(cfg.FanartShow, t, &b)
	enables[5] = addVideoTogetherHeader(cfg.VideoTogether, t, &b)

	b.WriteString(static.WebEmbededHeaderEnd)
	b.WriteString("\n")

	enable := false
	for _, v := range enables {
		if v {
			enable = true
			break
		}
	}

	if enable {
		if _, err := buff.Write(b.Bytes()); err != nil {
			logging.Errorf("写入嵌入脚本到外部请求头失败: %v", err)
			return false
		}
		logging.Infof("Web 配置中启用了嵌入脚本功能，已添加到外部请求头中: %s", b.String())
		return true
	}

	logging.Info("Web 配置中未启用嵌入脚本功能，未添加到外部请求头中")
	return false
}

func addExternalPlayerUrlHeader(enable bool, t constants.MediaServerType, buff *bytes.Buffer) bool {
	if enable {
		switch t {
		case constants.EMBY:
			buff.WriteString(static.ExternalPlayerUrl)
		case constants.JELLYFIN:
			buff.WriteString(static.ExternalPlayerUrl)
		default:
			logging.Warningf("未添加外置播放器脚本，不支持的媒体服务器类型：%s", t)
			return false
		}

		logging.Infof("Web 配置中启用了外置播放器功能，已添加到外部请求头中: %s", static.ExternalPlayerUrl)
		return true

	}

	if t == constants.EMBY || t == constants.JELLYFIN {
		logging.Infof("Web 配置中未启用外置播放器功能，未添加到外部请求头中")
	}
	return false
}

func addCrxHeader(enable bool, t constants.MediaServerType, buff *bytes.Buffer) bool {
	if enable {
		var str string
		switch t {
		case constants.EMBY:
			buff.WriteString(static.EmbyCrx)
			str = static.EmbyCrx
		case constants.JELLYFIN:
			buff.WriteString(static.JellyfinCrx)
			str = static.JellyfinCrx
		default:
			logging.Warningf("未添加 crx 美化脚本，不支持的媒体服务器类型：%s", t)
			return false
		}

		logging.Infof("Web 配置中启用了 crx 美化功能，已添加到外部请求头中: %s", str)
		return true
	}

	if t == constants.EMBY || t == constants.JELLYFIN {
		logging.Info("Web 配置中未启用 crx 美化功能，未添加到外部请求头中")
	}
	return false
}

func addDanmakuHeader(enable bool, t constants.MediaServerType, buff *bytes.Buffer) bool {
	if enable {
		var str string
		switch t {
		case constants.EMBY:
			buff.WriteString(static.EmbyDanmaku)
			str = static.EmbyDanmaku
		case constants.JELLYFIN:
			buff.WriteString(static.JellyfinDanmaku)
			str = static.JellyfinDanmaku
		case constants.FNTV:
			buff.WriteString(static.FNTVDanmaku)
			str = static.FNTVDanmaku
		default:
			logging.Warningf("未添加 Web 弹幕脚本，不支持的媒体服务器类型：%s", t)
			return false
		}

		logging.Infof("Web 配置中启用了 Web 弹幕功能，已添加到外部请求头中: %s", str)
		return true
	}

	if t == constants.EMBY || t == constants.JELLYFIN || t == constants.FNTV {
		logging.Infof("Web 配置中未启用 Web 弹幕功能，未添加到外部请求头中")
	}
	return false
}

func addActorPlusHeader(enable bool, t constants.MediaServerType, buff *bytes.Buffer) bool {
	if enable {
		switch t {
		case constants.EMBY:
			buff.WriteString(static.ActorPlus)
		case constants.JELLYFIN:
			buff.WriteString(static.ActorPlus)
		default:
			logging.Warningf("未添加演员头像脚本，不支持的媒体服务器类型：%s", t)
			return false
		}

		logging.Infof("Web 配置中启用了演员头像功能，已添加到外部请求头中: %s", static.ActorPlus)
		return true
	}

	if t == constants.EMBY || t == constants.JELLYFIN {
		logging.Infof("Web 配置中未启用演员头像功能，未添加到外部请求头中")
	}
	return false
}

func addFanartShowHeader(enable bool, t constants.MediaServerType, buff *bytes.Buffer) bool {
	if enable {
		switch t {
		case constants.EMBY:
			buff.WriteString(static.FanartShow)
		case constants.JELLYFIN:
			buff.WriteString(static.FanartShow)
		default:
			logging.Warningf("未添加同人图脚本，不支持的媒体服务器类型：%s", t)
			return false
		}

		logging.Infof("Web 配置中启用了同人图功能，已添加到外部请求头中: %s", static.FanartShow)
		return true
	}

	if t == constants.EMBY || t == constants.JELLYFIN {
		logging.Infof("Web 配置中未启用同人图功能，未添加到外部请求头中")
	}
	return false
}

func addVideoTogetherHeader(enable bool, _ constants.MediaServerType, buff *bytes.Buffer) bool {
	if enable {
		buff.WriteString(static.VideoTogether)
		logging.Infof("Web 配置中启用了 VideoTogether 功能，已添加到外部请求头中: %s", static.VideoTogether)
		return true
	}

	logging.Infof("Web 配置中未启用 VideoTogether 功能，未添加到外部请求头中")
	return false
}
