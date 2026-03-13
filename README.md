## picgo-plugin-cfbed-uploader

[PicGo](https://github.com/Molunerfinn/PicGo) uploader plugin for [CloudFlare ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed).

基于 CloudFlare ImgBed API（`/upload`）实现的 PicGo 上传插件，支持 API Token 或上传认证码上传。

### 本项目全部是ai编写

## 安装

### 离线安装

1. 克隆或下载本项目到本地
2. 在 PicGo 插件设置中选择“导入本地插件”
3. 选择本项目目录并重启 PicGo

## 配置项说明

| 参数名 | 类型 | 必填 | 说明 |
|:--|:--|:--:|:--|
| `host` | input | 是 | CloudFlare ImgBed 站点地址，如 `https://img.example.com` |
| `token` | password | 否 | API Token（建议至少具备 `upload` 权限） |
| `authCode` | input | 否 | 上传认证码；`token` 与 `authCode` 至少填写一个 |
| `uploadChannel` | list | 是 | 上传渠道：`telegram`、`cfr2`、`s3`、`discord`、`huggingface` |
| `channelName` | input | 否 | 指定渠道名称 |
| `uploadFolder` | input | 否 | 上传目录，如 `img/test` |
| `uploadNameType` | list | 是 | 命名方式：`default`、`index`、`origin`、`short` |
| `returnFormat` | list | 是 | 返回格式：`default` 或 `full` |
| `serverCompress` | confirm | 是 | 服务端压缩开关（仅 telegram 生效） |
| `autoRetry` | confirm | 是 | 失败自动重试开关 |
| `chunkSizeMB` | input | 是 | 分块大小（MB），默认 `8`，建议 `4~16`（仅 telegram/discord 分块时使用） |

![1](screenshot\1.png)
![2](screenshot\2.png)

## 分块上传支持

已支持 CloudFlare ImgBed 文档中的分块上传流程：

1. 初始化上传会话（`initChunked=true`）获取 `uploadId`
2. 逐片上传（`chunked=true` + `chunkIndex`）
3. 合并分片（`chunked=true&merge=true`）

当前插件会按渠道与文件大小自动判断是否需要分块：

| 渠道类型 | 优点 | 限制 | 插件策略 |
|:--|:--|:--|:--|
| Telegram Bot | 完全免费、无限容量 | 大于 20MB 文件需分片存储 | 超过 20MB 自动分块 |
| Cloudflare R2 | 无文件大小限制、企业级性能 | 超出 10G 免费额度后收费，需要绑定支付方式 | 默认直传 |
| S3 兼容存储 | 选择多样、价格灵活 | 根据服务商定价 | 默认直传 |
| Discord | 完全免费、简单易用 | 大于 10MB 文件需分片存储 | 超过 10MB 自动分块 |
| HuggingFace | 完全免费、支持大文件直传 | 需要 HuggingFace 账号 | 默认直传 |

> 说明：R2/S3/HuggingFace 默认不强制分块；如后端策略变化，可继续扩展为按阈值分块。

## 返回结果

- 上传成功后会设置 `imgUrl`
- 当返回值是 `/file/...` 形式时，会额外生成 `deleteUrl`，格式为：
  - `{host}/api/manage/delete/{filePath}`

> 注意：删除接口通常需要 `delete` 权限 Token，并在请求头带 `Authorization`；PicGo 默认删除行为是否使用该 URL 取决于客户端实现。

## 许可证

本插件采用 MIT 许可证。详见 [LICENSE](LICENSE.txt) 文件。

## 鸣谢

- [CloudFlare ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed) - 提供图床服务
- [PicGo](https://github.com/Molunerfinn/PicGo) - 高效创作者的最佳图片上传工具
