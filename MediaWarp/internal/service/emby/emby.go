package emby

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"github.com/AkimioJR/MediaWarp/constants"
	"github.com/AkimioJR/MediaWarp/utils"
)

type Client struct {
	baseURL *url.URL
	apiKey  string // 认证方式：APIKey；获取方式：Emby控制台 -> 高级 -> API密钥
	client  *http.Client
}

// 获取媒体服务器类型
func (client *Client) GetType() constants.MediaServerType {
	return constants.EMBY
}

// 获取Emby连接地址
//
// 包含协议、服务器域名（IP）、端口号
// 示例：return "http://emby.example.com:8096"
func (client *Client) GetBaseURLString() string {
	return client.baseURL.String()
}

// 获取Emby的API Key
func (client *Client) GetAPIKey() string {
	return client.apiKey
}

// ItemsService
// /Items
func (client *Client) ItemsServiceQueryItem(ids string, limit int, fields string) (*EmbyResponse, error) {
	var (
		params       = url.Values{}
		itemResponse = &EmbyResponse{}
	)
	params.Add("Ids", ids)
	params.Add("Limit", strconv.Itoa(limit))
	params.Add("Fields", fields)
	params.Add("Recursive", "true")
	params.Add("api_key", client.GetAPIKey())
	api := client.baseURL.JoinPath("Items")
	api.RawQuery = params.Encode()
	resp, err := client.client.Get(api.String())
	if err != nil {
		return nil, err
	}

	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	err = json.Unmarshal(body, itemResponse)
	if err != nil {
		return nil, err
	}
	return itemResponse, nil
}

// 获取index.html内容 API：/web/index.html
func (client *Client) GetIndexHtml() ([]byte, error) {
	resp, err := utils.GetHTTPClient().Get(client.baseURL.JoinPath("web/index.html").String())
	if err != nil {
		return nil, err
	}

	defer resp.Body.Close()
	htmlContent, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return htmlContent, nil
}

// 获取Emby实例
func New(baseURL string, apiKey string) (*Client, error) {
	parsedURL, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("解析 baseURL 失败: %w", err)
	}
	client := &Client{
		baseURL: parsedURL,
		apiKey:  apiKey,
		client:  utils.GetHTTPClient(),
	}
	return client, nil
}
