const fs = require('fs')

const DEFAULT_CHANNEL = 'telegram'
const DEFAULT_CHUNK_SIZE_MB = 20
const NO_CHUNK_CHANNELS = new Set(['huggingface'])

module.exports = (ctx) => {
  const register = () => {
    ctx.helper.uploader.register('cfbed', {
      handle,
      name: 'cfbed',
      config
    })
  }

  return {
    register,
    uploader: 'cfbed'
  }
}

const config = (ctx) => {
  const userConfig = ctx.getConfig('picBed.cfbed') || {}

  return [
    {
      name: 'host',
      type: 'input',
      default: userConfig.host || '',
      required: true,
      message: 'CloudFlare ImgBed 站点地址，例如：https://img.example.com',
      alias: '站点地址'
    },
    {
      name: 'token',
      type: 'password',
      default: userConfig.token || '',
      required: false,
      message: 'API 令牌（需要上传权限）',
      alias: 'API 令牌'
    },
    {
      name: 'authCode',
      type: 'input',
      default: userConfig.authCode || '',
      required: false,
      message: '上传认证码（可选，不填则使用令牌）',
      alias: '上传认证码'
    },
    {
      name: 'uploadChannel',
      type: 'list',
      choices: [
        { name: 'Telegram', value: 'telegram' },
        { name: 'Cloudflare R2', value: 'cfr2' },
        { name: 'S3', value: 's3' },
        { name: 'Discord', value: 'discord' },
        { name: 'Hugging Face', value: 'huggingface' }
      ],
      default: userConfig.uploadChannel || DEFAULT_CHANNEL,
      required: true,
      message: '上传渠道',
      alias: '上传渠道'
    },
    {
      name: 'channelName',
      type: 'input',
      default: userConfig.channelName || '',
      required: false,
      message: '渠道名称（可选）',
      alias: '渠道名称'
    },
    {
      name: 'uploadFolder',
      type: 'input',
      default: userConfig.uploadFolder || '',
      required: false,
      message: '上传目录（可选，例如：img/test）',
      alias: '上传目录'
    },
    {
      name: 'uploadNameType',
      type: 'list',
      choices: [
        { name: '前缀_原名', value: 'default' },
        { name: '仅前缀', value: 'index' },
        { name: '仅原名', value: 'origin' },
        { name: '短链接', value: 'short' }
      ],
      default: userConfig.uploadNameType || 'default',
      required: true,
      message: '文件命名方式',
      alias: '命名方式'
    },
    {
      name: 'returnFormat',
      type: 'list',
      choices: [
        { name: '默认', value: 'default' },
        { name: '完整链接', value: 'full' }
      ],
      default: userConfig.returnFormat || 'default',
      required: true,
      message: '返回链接格式',
      alias: '返回格式'
    },
    {
      name: 'autoRetry',
      type: 'confirm',
      default: userConfig.autoRetry !== false,
      required: true,
      message: '失败时是否自动切换渠道重试',
      alias: '自动重试'
    },
    {
      name: 'serverCompress',
      type: 'confirm',
      default: userConfig.serverCompress !== false,
      required: true,
      message: '服务端压缩（仅 Telegram 渠道有效）',
      alias: '服务端压缩'
    },
    {
      name: 'chunkSizeMB',
      type: 'input',
      default: userConfig.chunkSizeMB || String(DEFAULT_CHUNK_SIZE_MB),
      required: true,
      message: '分块大小（MB）',
      alias: '分块大小'
    }
  ]
}

const handle = async (ctx) => {
  const pluginConfig = normalizePluginConfig(ctx.getConfig('picBed.cfbed') || {})
  if (!pluginConfig.host) {
    throw new Error('CloudFlare ImgBed host 未配置')
  }
  if (!pluginConfig.token && !pluginConfig.authCode) {
    throw new Error('token 与 authCode 不能同时为空')
  }

  for (const img of ctx.output) {
    if (!img || !img.buffer || !img.fileName) {
      continue
    }

    const body = await uploadFile(ctx, pluginConfig, img)
    const src = pickSrcFromResponse(body)
    if (!src) {
      throw new Error('上传成功但未返回 src 字段')
    }

    delete img.base64Image
    delete img.buffer
    img.imgUrl = normalizeImageUrl(pluginConfig.host, src)

    const filePath = normalizePathFromSrc(src)
    if (filePath) {
      img.deleteUrl = buildDeleteUrl(pluginConfig.host, filePath)
    }
  }

  return ctx
}

const uploadFile = async (ctx, pluginConfig, img) => {
  const binary = ensureBuffer(img.buffer)
  const useChunked = shouldUseChunkedUpload(pluginConfig, binary)

  if (useChunked) {
    return uploadByChunks(ctx, pluginConfig, binary, img.fileName)
  }

  const req = buildUploadOptions(pluginConfig, binary, img.fileName)
  try {
    const response = await requestWithUploadFallback(ctx, req)
    return parseBody(response)
  } catch (error) {
    if (shouldFallbackToChunked(pluginConfig, error)) {
      ctx.log.warn('普通上传失败，自动改为分块上传重试')
      return uploadByChunks(ctx, pluginConfig, binary, img.fileName)
    }
    throw error
  }
}

const uploadByChunks = async (ctx, pluginConfig, binary, fileName) => {
  const chunkSize = getChunkSize(pluginConfig)
  const totalChunks = Math.ceil(binary.length / chunkSize)
  const originalFileType = guessMimeType(fileName)
  const metaForm = {
    totalChunks: String(totalChunks),
    originalFileName: fileName,
    originalFileType
  }

  const initReq = buildUploadOptions(pluginConfig, null, null, { initChunked: 'true' })
  initReq.formData = { ...metaForm }
  const initBody = parseBody(await requestWithUploadFallback(ctx, initReq))
  const uploadId = pickUploadId(initBody)
  if (!uploadId) {
    throw new Error('分块上传初始化失败，未获取 uploadId')
  }

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize, binary.length)
    const chunkReq = buildUploadOptions(pluginConfig, binary.slice(start, end), fileName, { chunked: 'true' })
    chunkReq.formData = {
      file: createFileFormField(binary.slice(start, end), fileName),
      uploadId,
      chunkIndex: String(i),
      ...metaForm
    }
    await requestWithUploadFallback(ctx, chunkReq)
  }

  const mergeReq = buildUploadOptions(pluginConfig, null, null, { chunked: 'true', merge: 'true' })
  mergeReq.formData = {
    uploadId,
    ...metaForm
  }
  const mergeBody = await requestWithUploadFallback(ctx, mergeReq)
  return parseBody(mergeBody)
}

const requestWithUploadFallback = async (ctx, requestOptions) => {
  try {
    return await ctx.request(requestOptions)
  } catch (error) {
    const status = getStatusCode(error)
    if (status !== 405) {
      throw error
    }

    const retryUrl = toggleUploadSlash(requestOptions.url)
    if (!retryUrl || retryUrl === requestOptions.url) {
      throw error
    }

    ctx.log.warn(`upload 405，切换地址重试: ${retryUrl}`)
    return ctx.request({
      ...requestOptions,
      url: retryUrl
    })
  }
}

const toggleUploadSlash = (url) => {
  if (typeof url !== 'string') {
    return url
  }
  if (/\/upload\//.test(url)) {
    return url.replace(/\/upload\/(\?|$)/, '/upload$1')
  }
  return url.replace(/\/upload(\?|$)/, '/upload/$1')
}

const buildUploadOptions = (pluginConfig, imageBuffer, fileName, extraQuery) => {
  const query = {
    ...buildBaseQuery(pluginConfig),
    ...(extraQuery || {})
  }

  const baseUrl = normalizeHost(pluginConfig.host)
  const req = {
    method: 'POST',
    url: `${baseUrl}/upload${toQueryString(query)}`,
    headers: buildHeaders(pluginConfig)
  }

  if (imageBuffer) {
    req.formData = {
      file: createFileFormField(imageBuffer, fileName)
    }
  }

  return req
}

const shouldUseChunkedUpload = (pluginConfig, binary) => {
  const channel = pluginConfig.uploadChannel || DEFAULT_CHANNEL
  if (NO_CHUNK_CHANNELS.has(channel)) {
    return false
  }

  const fileSize = getBinarySize(binary)
  const chunkSize = getChunkSize(pluginConfig)
  return fileSize > chunkSize
}

const shouldFallbackToChunked = (pluginConfig, error) => {
  const channel = pluginConfig.uploadChannel || DEFAULT_CHANNEL
  if (NO_CHUNK_CHANNELS.has(channel)) {
    return false
  }
  const status = getStatusCode(error)
  return status === 400 || status === 405 || status === 413
}

const getChunkSize = (pluginConfig) => {
  const mb = Number(pluginConfig.chunkSizeMB || DEFAULT_CHUNK_SIZE_MB)
  const safeMb = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_CHUNK_SIZE_MB
  return Math.floor(safeMb * 1024 * 1024)
}

const getBinarySize = (binary) => {
  if (!binary) return 0
  if (typeof binary.length === 'number') return binary.length
  if (typeof binary.size === 'number') return binary.size
  if (typeof binary.byteLength === 'number') return binary.byteLength
  if (binary.type === 'Buffer' && Array.isArray(binary.data)) return binary.data.length
  if (binary.path && typeof binary.path === 'string') {
    try {
      return fs.statSync(binary.path).size
    } catch (_) {}
  }
  return 0
}

const ensureBuffer = (binary) => {
  if (Buffer.isBuffer(binary)) return binary
  if (binary instanceof Uint8Array) return Buffer.from(binary)
  if (binary instanceof ArrayBuffer) return Buffer.from(binary)
  if (binary && binary.type === 'Buffer' && Array.isArray(binary.data)) return Buffer.from(binary.data)
  return binary
}

const parseBody = (response) => {
  if (typeof response === 'string') {
    try {
      return JSON.parse(response)
    } catch (_) {
      return {}
    }
  }
  return response
}

const normalizePluginConfig = (pluginConfig) => ({
  ...pluginConfig,
  host: normalizeHost(pluginConfig.host || ''),
  uploadChannel: pluginConfig.uploadChannel || DEFAULT_CHANNEL,
  uploadNameType: pluginConfig.uploadNameType || 'default',
  returnFormat: pluginConfig.returnFormat || 'default'
})

const buildBaseQuery = (pluginConfig) => {
  const query = {
    autoRetry: boolToString(pluginConfig.autoRetry, true),
    uploadChannel: pluginConfig.uploadChannel,
    uploadNameType: pluginConfig.uploadNameType,
    returnFormat: pluginConfig.returnFormat
  }

  if (pluginConfig.uploadChannel === DEFAULT_CHANNEL) {
    query.serverCompress = boolToString(pluginConfig.serverCompress, true)
  }
  if (pluginConfig.authCode) {
    query.authCode = pluginConfig.authCode
  }
  if (pluginConfig.channelName) {
    query.channelName = pluginConfig.channelName
  }
  if (pluginConfig.uploadFolder) {
    query.uploadFolder = pluginConfig.uploadFolder
  }

  return query
}

const buildHeaders = (pluginConfig) => {
  if (!pluginConfig.token) {
    return {}
  }
  return {
    Authorization: pluginConfig.token.startsWith('Bearer ')
      ? pluginConfig.token
      : `Bearer ${pluginConfig.token}`
  }
}

const createFileFormField = (buffer, fileName) => ({
  value: buffer,
  options: {
    filename: fileName
  }
})

const getStatusCode = (error) => error && (error.statusCode || (error.response && error.response.status))

const normalizeHost = (host) => host.replace(/\/$/, '')

const normalizeImageUrl = (host, src) => {
  if (/^https?:\/\//.test(src)) return src
  return `${normalizeHost(host)}${src.startsWith('/') ? '' : '/'}${src}`
}

const normalizePathFromSrc = (src) => {
  if (!src || !src.startsWith('/file/')) return ''
  return src.replace(/^\/file\//, '')
}

const pickSrcFromResponse = (body) => {
  if (!body) return ''
  if (Array.isArray(body) && body[0] && body[0].src) return body[0].src
  if (body.src) return body.src
  if (body.data && Array.isArray(body.data) && body.data[0] && body.data[0].src) return body.data[0].src
  if (body.data && body.data.src) return body.data.src
  return ''
}

const pickUploadId = (body) => {
  if (!body) return ''
  if (body.uploadId) return body.uploadId
  if (body.data && body.data.uploadId) return body.data.uploadId
  if (Array.isArray(body) && body[0] && body[0].uploadId) return body[0].uploadId
  return ''
}

const guessMimeType = (fileName) => {
  const ext = (fileName || '').split('.').pop().toLowerCase()
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    webm: 'video/webm'
  }
  return map[ext] || 'application/octet-stream'
}

const buildDeleteUrl = (host, filePath) => {
  const encoded = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${normalizeHost(host)}/api/manage/delete/${encoded}`
}

const boolToString = (value, defaultValue) => {
  const v = typeof value === 'boolean' ? value : defaultValue
  return v ? 'true' : 'false'
}

const toQueryString = (query) => {
  const entries = Object.entries(query).filter(([, value]) => value !== '' && value !== undefined && value !== null)
  if (entries.length === 0) return ''
  const str = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  return `?${str}`
}