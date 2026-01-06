import * as provider from './provider'
import * as gemini from './gemini'
import * as openai from './openai'
import * as claude from './claude'

// KV 键名
const KV_MODEL_MAPPING = 'model_mapping'
const KV_AVAILABLE_MODELS = 'available_models'
const KV_LAST_REFRESH = 'last_refresh'
const KV_PROXY_CONFIG = 'proxy_config'
const KV_REQUEST_LOGS = 'request_logs'
const KV_LAST_REQUEST = 'last_request'
const KV_LAST_RESPONSE = 'last_response'
const KV_LAST_USER_INPUT = 'last_user_input'

// 日志条目类型
interface RequestLog {
    id: string
    timestamp: string
    model: string
    mappedModel: string
    messagesCount: number
    hasImages: boolean
    stream: boolean
    status: number
    duration: number
    error?: string
}

// 代理配置缓存
let cachedProxyConfig: { baseUrl: string; apiKey: string } | null = null

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const startTime = Date.now()
        const requestId = crypto.randomUUID().slice(0, 8)

        try {
            // 初始化配置（模型映射和代理配置）
            await initConfig(env)

            const response = await handle(request, env, requestId, ctx)
            const duration = Date.now() - startTime
            console.log(
                `[${requestId}] ${request.method} ${new URL(request.url).pathname} - ${response.status} (${duration}ms)`
            )
            return response
        } catch (error) {
            const duration = Date.now() - startTime
            console.error(`[${requestId}] ERROR (${duration}ms):`, error)
            return new Response(
                JSON.stringify({
                    error: {
                        type: 'internal_error',
                        message: error instanceof Error ? error.message : 'Unknown error',
                        request_id: requestId
                    }
                }),
                {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                }
            )
        }
    }
} satisfies ExportedHandler<Env>

// 获取代理配置（优先从 KV，否则从环境变量）
async function getProxyConfig(env: Env): Promise<{ baseUrl: string; apiKey: string }> {
    // 如果有缓存，直接返回
    if (cachedProxyConfig) {
        return cachedProxyConfig
    }

    try {
        if (env.CONFIG_KV) {
            const savedConfig = await env.CONFIG_KV.get(KV_PROXY_CONFIG)
            if (savedConfig) {
                const config = JSON.parse(savedConfig)
                cachedProxyConfig = {
                    baseUrl: config.baseUrl || env.CLAUDE_BASE_URL || 'https://api.anthropic.com',
                    apiKey: config.apiKey || env.CLAUDE_API_KEY || ''
                }
                return cachedProxyConfig
            }
        }
    } catch (e) {
        console.error('[Config] Failed to load proxy config from KV:', e)
    }

    // 使用环境变量作为后备
    cachedProxyConfig = {
        baseUrl: env.CLAUDE_BASE_URL || 'https://api.anthropic.com',
        apiKey: env.CLAUDE_API_KEY || ''
    }
    return cachedProxyConfig
}

// 初始化配置（从 KV 加载模型映射和代理配置）
async function initConfig(env: Env) {
    try {
        if (env.CONFIG_KV) {
            // 加载模型映射
            const savedMapping = await env.CONFIG_KV.get(KV_MODEL_MAPPING)
            if (savedMapping) {
                const mapping = JSON.parse(savedMapping)
                claude.setModelMapping(mapping)
                console.log('[Init] Loaded model mapping from KV')
            }

            // 加载代理配置
            const savedConfig = await env.CONFIG_KV.get(KV_PROXY_CONFIG)
            if (savedConfig) {
                const config = JSON.parse(savedConfig)
                cachedProxyConfig = {
                    baseUrl: config.baseUrl || env.CLAUDE_BASE_URL || 'https://api.anthropic.com',
                    apiKey: config.apiKey || env.CLAUDE_API_KEY || ''
                }
                console.log('[Init] Loaded proxy config from KV')
            }
        }
    } catch (e) {
        console.error('[Init] Failed to load config from KV:', e)
    }
}

async function handle(request: Request, env: Env, requestId: string, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const pathname = url.pathname

    // 配置页面
    if (pathname === '/config' || pathname === '/settings') {
        return handleConfigPage(env)
    }

    // API: 获取代理支持的模型
    if (pathname === '/api/proxy-models') {
        return handleGetProxyModels(env)
    }

    // API: 获取当前映射配置
    if (pathname === '/api/mapping' && request.method === 'GET') {
        return handleGetMapping(env)
    }

    // API: 保存映射配置
    if (pathname === '/api/mapping' && request.method === 'POST') {
        return handleSaveMapping(request, env)
    }

    // API: 自动检测并设置最新模型
    if (pathname === '/api/auto-detect') {
        return handleAutoDetect(env)
    }

    // API: 获取代理配置
    if (pathname === '/api/proxy-config' && request.method === 'GET') {
        return handleGetProxyConfig(env)
    }

    // API: 保存代理配置
    if (pathname === '/api/proxy-config' && request.method === 'POST') {
        return handleSaveProxyConfig(request, env)
    }

    // API: 获取请求日志
    if (pathname === '/api/logs') {
        return handleGetLogs(env)
    }

    // 日志/调试页面
    if (pathname === '/logs' || pathname === '/debug') {
        return handleLogsPage(env)
    }

    // 测试端点 - 发送测试请求并返回详细信息
    if (pathname === '/test') {
        return handleTestEndpoint(env)
    }

    // OpenAI 兼容路由 - 支持多种路径格式
    if (
        pathname === '/v1/chat/completions' ||
        pathname === '/chat/completions' ||
        pathname.endsWith('/chat/completions')
    ) {
        if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405 })
        }
        return handleOpenAIToClaude(request, env, requestId, ctx)
    }

    // 模型列表端点（Cursor 需要）- 支持多种路径格式
    if (pathname === '/v1/models' || pathname === '/models' || pathname.endsWith('/models')) {
        return handleModels()
    }

    // 交互式聊天测试页面
    if (pathname === '/chat') {
        return handleChatPage(env)
    }

    // 根路径返回首页
    if (pathname === '/' || pathname === '') {
        return handleHomePage(env)
    }

    // 现有：Claude → Provider 路由
    if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 })
    }
    const { typeParam, baseUrl, err: pathErr } = parsePath(url)
    if (pathErr) {
        return pathErr
    }

    const { apiKey, mutatedHeaders, err: apiKeyErr } = getApiKey(request.headers)
    if (apiKeyErr) {
        return apiKeyErr
    }

    if (!apiKey || !typeParam || !baseUrl) {
        return new Response('Internal server error, missing params', { status: 500 })
    }

    let provider: provider.Provider
    switch (typeParam) {
        case 'gemini':
            provider = new gemini.impl()
            break
        case 'openai':
            provider = new openai.impl()
            break
        default:
            return new Response('Unsupported type', { status: 400 })
    }

    const providerRequest = await provider.convertToProviderRequest(
        new Request(request, { headers: mutatedHeaders }),
        baseUrl,
        apiKey
    )
    const providerResponse = await fetch(providerRequest)
    return await provider.convertToClaudeResponse(providerResponse)
}

async function handleOpenAIToClaude(
    request: Request,
    env: Env,
    requestId: string,
    ctx: ExecutionContext
): Promise<Response> {
    const startTime = Date.now()
    const proxyConfig = await getProxyConfig(env)
    const claudeApiKey = proxyConfig.apiKey
    const claudeBaseUrl = proxyConfig.baseUrl

    console.log(`[${requestId}] OpenAI → Claude conversion`)
    console.log(`[${requestId}] Target: ${claudeBaseUrl}`)

    if (!claudeApiKey) {
        console.error(`[${requestId}] Missing CLAUDE_API_KEY`)
        return new Response(
            JSON.stringify({
                error: {
                    type: 'config_error',
                    message: 'Missing CLAUDE_API_KEY environment variable',
                    request_id: requestId
                }
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        )
    }

    let requestBody: any = null
    let hasImages = false
    let mappedModel = ''

    try {
        // 克隆请求以便记录
        const requestClone = request.clone()
        requestBody = await requestClone.json()
        console.log(`[${requestId}] Request model: ${requestBody.model}`)
        console.log(`[${requestId}] Request messages count: ${requestBody.messages?.length}`)
        console.log(`[${requestId}] Request stream: ${requestBody.stream}`)

        // 保存最近一次请求内容到 KV（异步后台执行）
        if (env.CONFIG_KV) {
            ctx.waitUntil(env.CONFIG_KV.put(KV_LAST_REQUEST, JSON.stringify(requestBody, null, 2)))

            // 提取并保存用户最后一条输入（只保存用户在输入框中输入的内容）
            const lastUserMessage = extractLastUserInput(requestBody.messages)
            if (lastUserMessage) {
                ctx.waitUntil(env.CONFIG_KV.put(KV_LAST_USER_INPUT, lastUserMessage))
            }
        }

        // 检查是否有图片内容
        hasImages = requestBody.messages?.some(
            (m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url')
        )
        console.log(`[${requestId}] Has images: ${hasImages}`)

        const provider = new claude.ClaudeProvider()
        const claudeRequest = await provider.convertToProviderRequest(request, claudeBaseUrl, claudeApiKey)

        // 记录转换后的请求
        const claudeRequestClone = claudeRequest.clone()
        const claudeBody = await claudeRequestClone.json()
        mappedModel = claudeBody.model
        console.log(`[${requestId}] Claude request model: ${claudeBody.model}`)
        console.log(`[${requestId}] Claude request URL: ${claudeRequest.url}`)

        const claudeResponse = await fetch(claudeRequest)
        console.log(`[${requestId}] Claude response status: ${claudeResponse.status}`)

        if (!claudeResponse.ok) {
            const errorBody = await claudeResponse.clone().text()
            console.error(`[${requestId}] Claude error response: ${errorBody}`)

            // 保存错误响应到 KV（异步后台执行）
            if (env.CONFIG_KV) {
                ctx.waitUntil(env.CONFIG_KV.put(KV_LAST_RESPONSE, errorBody))
            }

            // 记录错误日志（异步后台执行）
            ctx.waitUntil(
                saveRequestLog(env, {
                    id: requestId,
                    timestamp: new Date().toISOString(),
                    model: requestBody?.model || 'unknown',
                    mappedModel: mappedModel || 'unknown',
                    messagesCount: requestBody?.messages?.length || 0,
                    hasImages,
                    stream: !!requestBody?.stream,
                    status: claudeResponse.status,
                    duration: Date.now() - startTime,
                    error: `Claude API error: ${claudeResponse.status}`
                })
            )

            return new Response(
                JSON.stringify({
                    error: {
                        type: 'provider_error',
                        message: `Claude API returned ${claudeResponse.status}`,
                        details: errorBody,
                        request_id: requestId
                    }
                }),
                { status: claudeResponse.status, headers: { 'Content-Type': 'application/json' } }
            )
        }

        // 记录成功日志（异步后台执行）
        ctx.waitUntil(
            saveRequestLog(env, {
                id: requestId,
                timestamp: new Date().toISOString(),
                model: requestBody?.model || 'unknown',
                mappedModel: mappedModel || 'unknown',
                messagesCount: requestBody?.messages?.length || 0,
                hasImages,
                stream: !!requestBody?.stream,
                status: claudeResponse.status,
                duration: Date.now() - startTime
            })
        )

        // 保存响应内容到 KV（异步后台执行）
        if (env.CONFIG_KV) {
            if (requestBody?.stream) {
                // 流式响应：保存说明
                ctx.waitUntil(
                    env.CONFIG_KV.put(
                        KV_LAST_RESPONSE,
                        JSON.stringify(
                            {
                                type: 'stream',
                                message: '流式响应（内容已实时传输，未保存完整内容）'
                            },
                            null,
                            2
                        )
                    )
                )
            } else {
                // 非流式响应：保存完整内容
                ctx.waitUntil(
                    (async () => {
                        try {
                            const responseClone = claudeResponse.clone()
                            const responseText = await responseClone.text()
                            await env.CONFIG_KV.put(KV_LAST_RESPONSE, responseText)
                        } catch (e) {
                            console.error('[Log] Failed to save response:', e)
                        }
                    })()
                )
            }
        }

        return await provider.convertToClaudeResponse(claudeResponse)
    } catch (error) {
        console.error(`[${requestId}] Conversion error:`, error)

        const errorResponse = JSON.stringify(
            {
                error: {
                    type: 'conversion_error',
                    message: error instanceof Error ? error.message : 'Unknown conversion error',
                    request_id: requestId
                }
            },
            null,
            2
        )

        // 保存异常响应到 KV（异步后台执行）
        if (env.CONFIG_KV) {
            ctx.waitUntil(env.CONFIG_KV.put(KV_LAST_RESPONSE, errorResponse))
        }

        // 记录异常日志（异步后台执行）
        ctx.waitUntil(
            saveRequestLog(env, {
                id: requestId,
                timestamp: new Date().toISOString(),
                model: requestBody?.model || 'unknown',
                mappedModel: mappedModel || 'unknown',
                messagesCount: requestBody?.messages?.length || 0,
                hasImages,
                stream: !!requestBody?.stream,
                status: 500,
                duration: Date.now() - startTime,
                error: error instanceof Error ? error.message : 'Unknown error'
            })
        )

        return new Response(errorResponse, {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        })
    }
}

// 提取用户最后一条输入内容（只提取用户在输入框中输入的文本）
function extractLastUserInput(messages: any[]): string | null {
    if (!messages || !Array.isArray(messages)) return null

    // 从后往前找最后一条 user 消息
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'user') {
            // 处理消息内容
            if (typeof msg.content === 'string') {
                return msg.content
            } else if (Array.isArray(msg.content)) {
                // 多模态消息，只提取文本部分
                const textParts = msg.content
                    .filter((part: any) => part.type === 'text')
                    .map((part: any) => part.text)
                    .join('\n')
                return textParts || null
            }
        }
    }
    return null
}

// 保存请求日志到 KV（只保留最近 5 条）
async function saveRequestLog(env: Env, log: RequestLog): Promise<void> {
    if (!env.CONFIG_KV) return

    try {
        const existingLogs = await env.CONFIG_KV.get(KV_REQUEST_LOGS)
        let logs: RequestLog[] = existingLogs ? JSON.parse(existingLogs) : []

        // 添加新日志到开头
        logs.unshift(log)

        // 只保留最近 5 条
        logs = logs.slice(0, 5)

        await env.CONFIG_KV.put(KV_REQUEST_LOGS, JSON.stringify(logs))
    } catch (e) {
        console.error('[Log] Failed to save request log:', e)
    }
}

// 获取请求日志 API
async function handleGetLogs(env: Env): Promise<Response> {
    let logs: RequestLog[] = []
    let lastRequest = ''
    let lastResponse = ''
    let lastUserInput = ''

    if (env.CONFIG_KV) {
        try {
            const logsData = await env.CONFIG_KV.get(KV_REQUEST_LOGS)
            if (logsData) {
                logs = JSON.parse(logsData)
            }

            const requestData = await env.CONFIG_KV.get(KV_LAST_REQUEST)
            if (requestData) {
                lastRequest = requestData
            }

            const responseData = await env.CONFIG_KV.get(KV_LAST_RESPONSE)
            if (responseData) {
                lastResponse = responseData
            }

            const userInputData = await env.CONFIG_KV.get(KV_LAST_USER_INPUT)
            if (userInputData) {
                lastUserInput = userInputData
            }
        } catch (e) {
            console.error('[Log] Failed to get logs:', e)
        }
    }

    return new Response(
        JSON.stringify({
            logs,
            lastRequest,
            lastResponse,
            lastUserInput
        }),
        { headers: { 'Content-Type': 'application/json' } }
    )
}

// 获取代理服务支持的模型列表
async function handleGetProxyModels(env: Env): Promise<Response> {
    const proxyConfig = await getProxyConfig(env)
    const claudeBaseUrl = proxyConfig.baseUrl
    const claudeApiKey = proxyConfig.apiKey

    try {
        const modelsUrl = `${claudeBaseUrl}/v1/models`
        const response = await fetch(modelsUrl, {
            headers: {
                'x-api-key': claudeApiKey || '',
                'anthropic-version': '2023-06-01'
            }
        })

        if (!response.ok) {
            return new Response(
                JSON.stringify({
                    error: 'Failed to fetch models from proxy',
                    status: response.status,
                    proxy_url: claudeBaseUrl
                }),
                { status: response.status, headers: { 'Content-Type': 'application/json' } }
            )
        }

        const data = await response.json()

        // 缓存到 KV
        if (env.CONFIG_KV) {
            await env.CONFIG_KV.put(KV_AVAILABLE_MODELS, JSON.stringify(data))
            await env.CONFIG_KV.put(KV_LAST_REFRESH, new Date().toISOString())
        }

        return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json' }
        })
    } catch (error) {
        return new Response(
            JSON.stringify({
                error: 'Failed to fetch models',
                message: error instanceof Error ? error.message : 'Unknown error'
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        )
    }
}

// 获取当前模型映射配置
async function handleGetMapping(env: Env): Promise<Response> {
    const currentMapping = claude.getModelMapping()

    let lastRefresh = null
    if (env.CONFIG_KV) {
        lastRefresh = await env.CONFIG_KV.get(KV_LAST_REFRESH)
    }

    return new Response(
        JSON.stringify({
            mapping: currentMapping,
            default_mapping: claude.DEFAULT_MODEL_MAPPING,
            last_refresh: lastRefresh
        }),
        {
            headers: { 'Content-Type': 'application/json' }
        }
    )
}

// 保存模型映射配置
async function handleSaveMapping(request: Request, env: Env): Promise<Response> {
    try {
        const body = (await request.json()) as { mapping: { [key: string]: string } }
        const newMapping = body.mapping

        if (!newMapping || typeof newMapping !== 'object') {
            return new Response(JSON.stringify({ error: 'Invalid mapping format' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            })
        }

        // 更新内存中的映射
        claude.setModelMapping(newMapping)

        // 保存到 KV
        if (env.CONFIG_KV) {
            await env.CONFIG_KV.put(KV_MODEL_MAPPING, JSON.stringify(newMapping))
        }

        return new Response(
            JSON.stringify({
                success: true,
                mapping: claude.getModelMapping()
            }),
            {
                headers: { 'Content-Type': 'application/json' }
            }
        )
    } catch (error) {
        return new Response(
            JSON.stringify({
                error: 'Failed to save mapping',
                message: error instanceof Error ? error.message : 'Unknown error'
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        )
    }
}

// 自动检测最新模型并设置映射
async function handleAutoDetect(env: Env): Promise<Response> {
    const proxyConfig = await getProxyConfig(env)
    const claudeBaseUrl = proxyConfig.baseUrl
    const claudeApiKey = proxyConfig.apiKey

    try {
        // 获取可用模型
        const modelsUrl = `${claudeBaseUrl}/v1/models`
        const response = await fetch(modelsUrl, {
            headers: {
                'x-api-key': claudeApiKey || '',
                'anthropic-version': '2023-06-01'
            }
        })

        if (!response.ok) {
            return new Response(
                JSON.stringify({
                    error: 'Failed to fetch models for auto-detect'
                }),
                { status: response.status, headers: { 'Content-Type': 'application/json' } }
            )
        }

        const data = (await response.json()) as { data: Array<{ id: string }> }
        const models = data.data?.map(m => m.id) || []

        // 找到最新的 sonnet 和 opus 模型
        const sonnetModels = models
            .filter(m => m.includes('sonnet'))
            .sort()
            .reverse()
        const opusModels = models
            .filter(m => m.includes('opus'))
            .sort()
            .reverse()
        const haikuModels = models
            .filter(m => m.includes('haiku'))
            .sort()
            .reverse()

        const latestSonnet = sonnetModels[0] || 'claude-sonnet-4-5-20250929'
        const latestOpus = opusModels[0] || 'claude-opus-4-5-20251101'
        const latestHaiku = haikuModels[0] || 'claude-haiku-4-5-20251001'

        const newMapping = {
            'tinyy-model': latestSonnet,
            'bigger-model': latestOpus,
            'gpt-4': latestOpus,
            'gpt-4o': latestSonnet,
            'gpt-4-turbo': latestSonnet,
            'gpt-3.5-turbo': latestHaiku
        }

        // 更新映射
        claude.setModelMapping(newMapping)

        // 保存到 KV
        if (env.CONFIG_KV) {
            await env.CONFIG_KV.put(KV_MODEL_MAPPING, JSON.stringify(newMapping))
            await env.CONFIG_KV.put(KV_AVAILABLE_MODELS, JSON.stringify(data))
            await env.CONFIG_KV.put(KV_LAST_REFRESH, new Date().toISOString())
        }

        return new Response(
            JSON.stringify({
                success: true,
                detected: {
                    sonnet: sonnetModels,
                    opus: opusModels,
                    haiku: haikuModels
                },
                selected: {
                    latestSonnet,
                    latestOpus,
                    latestHaiku
                },
                mapping: newMapping,
                all_models: models
            }),
            {
                headers: { 'Content-Type': 'application/json' }
            }
        )
    } catch (error) {
        return new Response(
            JSON.stringify({
                error: 'Auto-detect failed',
                message: error instanceof Error ? error.message : 'Unknown error'
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        )
    }
}

// 获取代理配置 API
async function handleGetProxyConfig(env: Env): Promise<Response> {
    const proxyConfig = await getProxyConfig(env)

    return new Response(
        JSON.stringify({
            baseUrl: proxyConfig.baseUrl,
            apiKey: proxyConfig.apiKey ? proxyConfig.apiKey.slice(0, 10) + '...' : '',
            apiKeySet: !!proxyConfig.apiKey,
            envBaseUrl: env.CLAUDE_BASE_URL || 'https://api.anthropic.com',
            envApiKeySet: !!env.CLAUDE_API_KEY
        }),
        { headers: { 'Content-Type': 'application/json' } }
    )
}

// 保存代理配置 API
async function handleSaveProxyConfig(request: Request, env: Env): Promise<Response> {
    try {
        const body = (await request.json()) as { baseUrl?: string; apiKey?: string }

        // 获取当前配置
        const currentConfig = await getProxyConfig(env)

        // 更新配置
        const newConfig = {
            baseUrl: body.baseUrl || currentConfig.baseUrl,
            apiKey: body.apiKey || currentConfig.apiKey
        }

        // 保存到 KV
        if (env.CONFIG_KV) {
            await env.CONFIG_KV.put(KV_PROXY_CONFIG, JSON.stringify(newConfig))
        }

        // 更新缓存
        cachedProxyConfig = newConfig

        return new Response(
            JSON.stringify({
                success: true,
                baseUrl: newConfig.baseUrl,
                apiKeySet: !!newConfig.apiKey
            }),
            { headers: { 'Content-Type': 'application/json' } }
        )
    } catch (error) {
        return new Response(
            JSON.stringify({
                error: 'Failed to save proxy config',
                message: error instanceof Error ? error.message : 'Unknown error'
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        )
    }
}

// 首页
async function handleHomePage(env: Env): Promise<Response> {
    const proxyConfig = await getProxyConfig(env)
    const currentMapping = claude.getModelMapping()

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Claude Worker Proxy</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #eee; min-height: 100vh; }
        .container { max-width: 1200px; margin: 0 auto; padding: 40px 20px; }
        .header { text-align: center; margin-bottom: 50px; }
        .header h1 { font-size: 48px; color: #00d4ff; margin-bottom: 15px; text-shadow: 0 0 30px rgba(0, 212, 255, 0.3); }
        .header p { color: #888; font-size: 18px; }
        .nav-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 25px; margin-bottom: 50px; }
        .nav-card { background: linear-gradient(145deg, #1e2a4a, #16213e); border-radius: 16px; padding: 30px; cursor: pointer; transition: all 0.3s ease; border: 1px solid #2a3f5f; text-decoration: none; color: inherit; display: block; }
        .nav-card:hover { transform: translateY(-5px); box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3); border-color: #00d4ff; }
        .nav-card .icon { font-size: 48px; margin-bottom: 15px; }
        .nav-card h2 { font-size: 24px; margin-bottom: 10px; color: #00d4ff; }
        .nav-card p { color: #888; line-height: 1.6; }
        .status-section { background: #16213e; border-radius: 16px; padding: 30px; margin-bottom: 30px; }
        .status-section h3 { color: #00d4ff; margin-bottom: 20px; font-size: 20px; display: flex; align-items: center; gap: 10px; }
        .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; }
        .status-item { background: #0f3460; border-radius: 10px; padding: 20px; }
        .status-item label { color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; display: block; margin-bottom: 8px; }
        .status-item .value { color: #fff; font-size: 16px; font-family: 'Monaco', monospace; word-break: break-all; }
        .status-item .value.success { color: #00ff88; }
        .status-item .value.warning { color: #ffaa00; }
        .mapping-table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        .mapping-table th, .mapping-table td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #2a3f5f; }
        .mapping-table th { color: #888; font-weight: normal; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
        .mapping-table td { font-family: 'Monaco', monospace; font-size: 14px; }
        .mapping-table .alias { color: #00d4ff; }
        .mapping-table .arrow { color: #666; padding: 0 15px; }
        .mapping-table .model { color: #00ff88; }
        .endpoint-list { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 15px; }
        .endpoint { background: #0f3460; padding: 8px 15px; border-radius: 20px; font-family: monospace; font-size: 13px; }
        .endpoint .method { background: #00d4ff; color: #000; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; margin-right: 8px; }
        .endpoint .method.post { background: #e94560; color: #fff; }
        .footer { text-align: center; color: #666; margin-top: 50px; font-size: 14px; }
        .footer a { color: #00d4ff; text-decoration: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 Claude Worker Proxy</h1>
            <p>OpenAI API 兼容的 Claude 代理服务</p>
        </div>

        <div class="nav-cards">
            <a href="/config" class="nav-card">
                <div class="icon">⚙️</div>
                <h2>配置管理</h2>
                <p>设置代理服务的 Base URL 和 API Key，配置模型映射关系，自动检测最新模型。</p>
            </a>
            <a href="/chat" class="nav-card">
                <div class="icon">💬</div>
                <h2>交互测试</h2>
                <p>选择任意可用模型，直接与 AI 进行对话测试，实时查看响应效果。</p>
            </a>
            <a href="/logs" class="nav-card">
                <div class="icon">📋</div>
                <h2>调试日志</h2>
                <p>查看请求日志和调试信息，排查问题，监控服务运行状态。</p>
            </a>
        </div>

        <div class="status-section">
            <h3>🔌 代理配置</h3>
            <div class="status-grid">
                <div class="status-item">
                    <label>Base URL</label>
                    <div class="value">${proxyConfig.baseUrl}</div>
                </div>
                <div class="status-item">
                    <label>API Key</label>
                    <div class="value ${proxyConfig.apiKey ? 'success' : 'warning'}">${proxyConfig.apiKey ? '✓ 已配置 (' + proxyConfig.apiKey.slice(0, 8) + '...)' : '⚠ 未配置'}</div>
                </div>
                <div class="status-item">
                    <label>服务状态</label>
                    <div class="value success">● 运行中</div>
                </div>
            </div>
        </div>

        <div class="status-section">
            <h3>🔧 模型映射</h3>
            <table class="mapping-table">
                <thead>
                    <tr>
                        <th>别名</th>
                        <th></th>
                        <th>实际模型</th>
                    </tr>
                </thead>
                <tbody>
                    ${Object.entries(currentMapping)
                        .map(
                            ([alias, model]) => `
                    <tr>
                        <td class="alias">${alias}</td>
                        <td class="arrow">→</td>
                        <td class="model">${model}</td>
                    </tr>`
                        )
                        .join('')}
                </tbody>
            </table>
        </div>

        <div class="status-section">
            <h3>📡 API 端点</h3>
            <div class="endpoint-list">
                <div class="endpoint"><span class="method post">POST</span>/v1/chat/completions</div>
                <div class="endpoint"><span class="method">GET</span>/v1/models</div>
                <div class="endpoint"><span class="method">GET</span>/api/proxy-models</div>
                <div class="endpoint"><span class="method">GET</span>/api/mapping</div>
                <div class="endpoint"><span class="method post">POST</span>/api/mapping</div>
                <div class="endpoint"><span class="method">GET</span>/api/auto-detect</div>
            </div>
        </div>

        <div class="footer">
            <p>Powered by <a href="https://workers.cloudflare.com" target="_blank">Cloudflare Workers</a> |
               <a href="https://github.com" target="_blank">GitHub</a></p>
        </div>
    </div>
</body>
</html>`

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
}

// 交互式聊天测试页面
async function handleChatPage(env: Env): Promise<Response> {
    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Claude Worker Proxy - 交互测试</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; height: 100vh; display: flex; flex-direction: column; }
        .header { background: #16213e; padding: 15px 20px; display: flex; align-items: center; gap: 20px; border-bottom: 1px solid #2a3f5f; }
        .header h1 { font-size: 20px; color: #00d4ff; flex-shrink: 0; }
        .header .nav { display: flex; gap: 15px; }
        .header .nav a { color: #888; text-decoration: none; font-size: 14px; }
        .header .nav a:hover { color: #00d4ff; }
        .model-selector { display: flex; align-items: center; gap: 10px; margin-left: auto; }
        .model-selector label { color: #888; font-size: 14px; }
        .model-selector select { padding: 8px 12px; border: 1px solid #2a3f5f; border-radius: 8px; background: #0f3460; color: #fff; font-size: 14px; min-width: 200px; }
        .model-selector select:focus { outline: none; border-color: #00d4ff; }
        .chat-container { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 15px; }
        .message { max-width: 80%; padding: 15px 20px; border-radius: 16px; line-height: 1.6; animation: fadeIn 0.3s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .message.user { background: #0f3460; align-self: flex-end; border-bottom-right-radius: 4px; }
        .message.assistant { background: #16213e; align-self: flex-start; border-bottom-left-radius: 4px; border: 1px solid #2a3f5f; }
        .message.system { background: #2a3f5f; align-self: center; font-size: 13px; color: #888; padding: 10px 20px; }
        .message.error { background: #3d1a1a; border: 1px solid #e94560; color: #ff8888; }
        .message pre { background: #0a1929; padding: 12px; border-radius: 8px; overflow-x: auto; margin: 10px 0; font-size: 13px; }
        .message code { font-family: 'Monaco', 'Consolas', monospace; }
        .message p { margin: 8px 0; }
        .message p:first-child { margin-top: 0; }
        .message p:last-child { margin-bottom: 0; }
        .typing-indicator { display: flex; gap: 4px; padding: 15px 20px; }
        .typing-indicator span { width: 8px; height: 8px; background: #00d4ff; border-radius: 50%; animation: bounce 1.4s infinite ease-in-out; }
        .typing-indicator span:nth-child(1) { animation-delay: -0.32s; }
        .typing-indicator span:nth-child(2) { animation-delay: -0.16s; }
        @keyframes bounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }
        .input-container { padding: 20px; background: #16213e; border-top: 1px solid #2a3f5f; }
        .input-wrapper { display: flex; gap: 10px; max-width: 1000px; margin: 0 auto; }
        .input-wrapper textarea { flex: 1; padding: 15px; border: 1px solid #2a3f5f; border-radius: 12px; background: #0f3460; color: #fff; font-size: 15px; resize: none; min-height: 50px; max-height: 150px; font-family: inherit; }
        .input-wrapper textarea:focus { outline: none; border-color: #00d4ff; }
        .input-wrapper textarea::placeholder { color: #666; }
        .send-btn { padding: 15px 25px; background: #00d4ff; color: #000; border: none; border-radius: 12px; cursor: pointer; font-size: 15px; font-weight: 600; transition: all 0.2s; flex-shrink: 0; }
        .send-btn:hover { background: #00b8e6; }
        .send-btn:disabled { background: #2a3f5f; color: #666; cursor: not-allowed; }
        .clear-btn { padding: 15px; background: transparent; color: #888; border: 1px solid #2a3f5f; border-radius: 12px; cursor: pointer; font-size: 14px; transition: all 0.2s; }
        .clear-btn:hover { border-color: #e94560; color: #e94560; }
        .welcome { text-align: center; padding: 60px 20px; color: #666; }
        .welcome h2 { font-size: 28px; color: #00d4ff; margin-bottom: 15px; }
        .welcome p { font-size: 16px; max-width: 500px; margin: 0 auto; line-height: 1.6; }
        .model-info { font-size: 12px; color: #666; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>💬 交互测试</h1>
        <div class="nav">
            <a href="/">首页</a>
            <a href="/config">配置</a>
            <a href="/logs">日志</a>
        </div>
        <div class="model-selector">
            <label>模型:</label>
            <select id="modelSelect">
                <option value="">加载中...</option>
            </select>
        </div>
    </div>

    <div class="chat-container" id="chatContainer">
        <div class="welcome">
            <h2>开始对话</h2>
            <p>选择一个模型，然后输入消息开始与 AI 对话。支持实时流式响应。</p>
            <div class="model-info" id="modelInfo"></div>
        </div>
    </div>

    <div class="input-container">
        <div class="input-wrapper">
            <textarea id="messageInput" placeholder="输入消息... (Enter 发送, Shift+Enter 换行)" rows="1"></textarea>
            <button class="send-btn" id="sendBtn" onclick="sendMessage()">发送</button>
            <button class="clear-btn" onclick="clearChat()">清空</button>
        </div>
    </div>

    <script>
        let messages = [];
        let isLoading = false;
        let availableModels = [];

        // 加载可用模型
        async function loadModels() {
            try {
                const res = await fetch('/api/proxy-models');
                const data = await res.json();

                if (data.data && data.data.length > 0) {
                    availableModels = data.data.map(m => m.id);
                    updateModelSelect();
                } else {
                    // 如果无法获取代理模型，使用映射的别名
                    const mappingRes = await fetch('/api/mapping');
                    const mappingData = await mappingRes.json();
                    availableModels = Object.keys(mappingData.mapping || {});
                    updateModelSelect();
                }
            } catch (e) {
                console.error('Failed to load models:', e);
                // 使用默认模型
                availableModels = ['tinyy-model', 'bigger-model'];
                updateModelSelect();
            }
        }

        function updateModelSelect() {
            const select = document.getElementById('modelSelect');
            select.innerHTML = availableModels.map(m =>
                '<option value="' + m + '">' + m + '</option>'
            ).join('');

            // 默认选择 tinyy-model 或第一个
            if (availableModels.includes('tinyy-model')) {
                select.value = 'tinyy-model';
            }

            updateModelInfo();
        }

        function updateModelInfo() {
            const select = document.getElementById('modelSelect');
            const info = document.getElementById('modelInfo');
            if (info) {
                info.textContent = '当前选择: ' + select.value;
            }
        }

        document.getElementById('modelSelect').addEventListener('change', updateModelInfo);

        // 自动调整文本框高度
        const textarea = document.getElementById('messageInput');
        textarea.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 150) + 'px';
        });

        // 键盘快捷键
        textarea.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        function addMessage(role, content, isError = false) {
            const container = document.getElementById('chatContainer');

            // 移除欢迎消息
            const welcome = container.querySelector('.welcome');
            if (welcome) welcome.remove();

            const div = document.createElement('div');
            div.className = 'message ' + role + (isError ? ' error' : '');
            div.innerHTML = formatMessage(content);
            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
            return div;
        }

        function formatMessage(text) {
            // 简单的 markdown 处理
            return text
                .replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>')
                .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                .replace(/\\n/g, '<br>');
        }

        function showTyping() {
            const container = document.getElementById('chatContainer');
            const div = document.createElement('div');
            div.className = 'message assistant';
            div.id = 'typingIndicator';
            div.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
        }

        function removeTyping() {
            const typing = document.getElementById('typingIndicator');
            if (typing) typing.remove();
        }

        async function sendMessage() {
            const input = document.getElementById('messageInput');
            const content = input.value.trim();
            if (!content || isLoading) return;

            const model = document.getElementById('modelSelect').value;
            if (!model) {
                addMessage('system', '请先选择一个模型');
                return;
            }

            // 添加用户消息
            messages.push({ role: 'user', content });
            addMessage('user', content);
            input.value = '';
            input.style.height = 'auto';

            // 禁用发送按钮
            isLoading = true;
            document.getElementById('sendBtn').disabled = true;
            showTyping();

            try {
                const response = await fetch('/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: model,
                        messages: messages,
                        stream: true
                    })
                });

                removeTyping();

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error?.message || 'Request failed: ' + response.status);
                }

                // 处理流式响应
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let assistantContent = '';
                let messageDiv = null;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\\n');

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        const jsonStr = line.slice(6);
                        if (jsonStr === '[DONE]') continue;

                        try {
                            const data = JSON.parse(jsonStr);
                            const delta = data.choices?.[0]?.delta?.content;
                            if (delta) {
                                assistantContent += delta;
                                if (!messageDiv) {
                                    messageDiv = addMessage('assistant', assistantContent);
                                } else {
                                    messageDiv.innerHTML = formatMessage(assistantContent);
                                }
                                document.getElementById('chatContainer').scrollTop =
                                    document.getElementById('chatContainer').scrollHeight;
                            }
                        } catch (e) {
                            // 忽略解析错误
                        }
                    }
                }

                if (assistantContent) {
                    messages.push({ role: 'assistant', content: assistantContent });
                }

            } catch (error) {
                removeTyping();
                addMessage('assistant', '错误: ' + error.message, true);
            } finally {
                isLoading = false;
                document.getElementById('sendBtn').disabled = false;
                input.focus();
            }
        }

        function clearChat() {
            messages = [];
            const container = document.getElementById('chatContainer');
            container.innerHTML = '<div class="welcome"><h2>开始对话</h2><p>选择一个模型，然后输入消息开始与 AI 对话。支持实时流式响应。</p><div class="model-info" id="modelInfo"></div></div>';
            updateModelInfo();
        }

        // 初始化
        loadModels();
        document.getElementById('messageInput').focus();
    </script>
</body>
</html>`

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
}

// 配置页面
async function handleConfigPage(env: Env): Promise<Response> {
    const currentMapping = claude.getModelMapping()
    const mappingJson = JSON.stringify(currentMapping, null, 2)
    const proxyConfig = await getProxyConfig(env)

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Claude Worker Proxy - 配置</title>
    <meta charset="utf-8">
    <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1000px; margin: 0 auto; padding: 20px; background: #1a1a2e; color: #eee; }
        h1 { color: #00d4ff; margin-bottom: 30px; }
        h2 { color: #00d4ff; font-size: 18px; margin-top: 0; }
        .card { background: #16213e; border-radius: 12px; padding: 24px; margin: 20px 0; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
        label { display: block; margin-bottom: 8px; color: #aaa; font-size: 14px; }
        select, input { width: 100%; padding: 12px; border: 1px solid #0f3460; border-radius: 8px; background: #0f3460; color: #fff; font-size: 14px; }
        select:focus, input:focus { outline: none; border-color: #00d4ff; }
        button { padding: 12px 24px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; transition: all 0.2s; }
        .btn-primary { background: #00d4ff; color: #000; }
        .btn-primary:hover { background: #00b8e6; }
        .btn-secondary { background: #e94560; color: #fff; }
        .btn-secondary:hover { background: #d63850; }
        .btn-outline { background: transparent; border: 1px solid #00d4ff; color: #00d4ff; }
        .btn-outline:hover { background: #00d4ff22; }
        .btn-group { display: flex; gap: 10px; margin-top: 20px; }
        .model-list { max-height: 300px; overflow-y: auto; background: #0f3460; border-radius: 8px; padding: 15px; }
        .model-item { padding: 8px 12px; margin: 4px 0; background: #16213e; border-radius: 6px; font-family: monospace; font-size: 13px; }
        .model-item.sonnet { border-left: 3px solid #00d4ff; }
        .model-item.opus { border-left: 3px solid #e94560; }
        .model-item.haiku { border-left: 3px solid #00ff88; }
        .status { padding: 10px 15px; border-radius: 8px; margin-top: 15px; }
        .status.success { background: #00ff8822; border: 1px solid #00ff88; }
        .status.error { background: #e9456022; border: 1px solid #e94560; }
        .status.loading { background: #00d4ff22; border: 1px solid #00d4ff; }
        .mapping-row { display: flex; align-items: center; gap: 15px; padding: 12px; background: #0f3460; border-radius: 8px; margin: 8px 0; }
        .mapping-row .alias { font-weight: 600; color: #00d4ff; min-width: 120px; }
        .mapping-row .arrow { color: #666; }
        .mapping-row select { flex: 1; }
        .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        a { color: #00d4ff; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .nav { margin-bottom: 30px; }
        .nav a { margin-right: 20px; }
    </style>
</head>
<body>
    <div class="nav">
        <a href="/">首页</a>
        <a href="/config">配置</a>
        <a href="/logs">日志</a>
        <a href="/test">测试</a>
    </div>

    <h1>⚙️ 代理配置</h1>

    <div class="card">
        <h2>🔌 代理服务设置</h2>
        <div style="margin-bottom: 15px;">
            <label>Claude API Base URL</label>
            <input type="text" id="proxy-base-url" placeholder="https://api.anthropic.com" value="${proxyConfig.baseUrl}">
        </div>
        <div style="margin-bottom: 15px;">
            <label>API Key（留空则使用环境变量配置）</label>
            <input type="password" id="proxy-api-key" placeholder="输入新的 API Key 或留空保持不变">
        </div>
        <div class="btn-group">
            <button class="btn-primary" onclick="saveProxyConfig()">保存代理配置</button>
            <button class="btn-outline" onclick="testProxyConnection()">测试连接</button>
        </div>
        <div id="proxyStatus"></div>
    </div>

    <h2 style="margin-top: 30px;">📋 模型配置</h2>

    <div class="grid">
        <div class="card">
            <div class="header-row">
                <h2>📡 代理支持的模型</h2>
                <button class="btn-outline" onclick="refreshModels()">刷新</button>
            </div>
            <div id="modelList" class="model-list">
                <div class="status loading">正在加载...</div>
            </div>
        </div>

        <div class="card">
            <div class="header-row">
                <h2>🔧 模型映射配置</h2>
                <button class="btn-secondary" onclick="autoDetect()">自动检测</button>
            </div>
            <div id="mappingConfig">
                <div class="mapping-row">
                    <span class="alias">tinyy-model</span>
                    <span class="arrow">→</span>
                    <select id="map-tinyy-model"></select>
                </div>
                <div class="mapping-row">
                    <span class="alias">bigger-model</span>
                    <span class="arrow">→</span>
                    <select id="map-bigger-model"></select>
                </div>
                <div class="mapping-row">
                    <span class="alias">gpt-4</span>
                    <span class="arrow">→</span>
                    <select id="map-gpt-4"></select>
                </div>
                <div class="mapping-row">
                    <span class="alias">gpt-4o</span>
                    <span class="arrow">→</span>
                    <select id="map-gpt-4o"></select>
                </div>
                <div class="mapping-row">
                    <span class="alias">gpt-3.5-turbo</span>
                    <span class="arrow">→</span>
                    <select id="map-gpt-3-5-turbo"></select>
                </div>
            </div>
            <div class="btn-group">
                <button class="btn-primary" onclick="saveMapping()">保存配置</button>
            </div>
            <div id="saveStatus"></div>
        </div>
    </div>

    <div class="card">
        <h2>📋 当前配置</h2>
        <pre id="currentConfig" style="background: #0f3460; padding: 15px; border-radius: 8px; overflow-x: auto;">${mappingJson}</pre>
    </div>

    <script>
        let availableModels = [];
        const aliases = ['tinyy-model', 'bigger-model', 'gpt-4', 'gpt-4o', 'gpt-3.5-turbo'];

        async function refreshModels() {
            const list = document.getElementById('modelList');
            list.innerHTML = '<div class="status loading">正在加载...</div>';

            try {
                const res = await fetch('/api/proxy-models');
                const data = await res.json();

                if (data.error) {
                    list.innerHTML = '<div class="status error">加载失败: ' + data.error + '</div>';
                    return;
                }

                availableModels = data.data?.map(m => m.id) || [];
                updateModelList();
                updateSelects();
            } catch (e) {
                list.innerHTML = '<div class="status error">加载失败: ' + e.message + '</div>';
            }
        }

        function updateModelList() {
            const list = document.getElementById('modelList');
            if (availableModels.length === 0) {
                list.innerHTML = '<div class="status">暂无模型数据</div>';
                return;
            }

            list.innerHTML = availableModels.map(m => {
                let cls = '';
                if (m.includes('sonnet')) cls = 'sonnet';
                else if (m.includes('opus')) cls = 'opus';
                else if (m.includes('haiku')) cls = 'haiku';
                return '<div class="model-item ' + cls + '">' + m + '</div>';
            }).join('');
        }

        function updateSelects() {
            aliases.forEach(alias => {
                const selectId = 'map-' + alias.replace(/\\./g, '-');
                const select = document.getElementById(selectId);
                if (!select) return;

                const currentValue = select.value;
                select.innerHTML = availableModels.map(m =>
                    '<option value="' + m + '">' + m + '</option>'
                ).join('');

                if (currentValue) select.value = currentValue;
            });
        }

        async function loadCurrentMapping() {
            try {
                const res = await fetch('/api/mapping');
                const data = await res.json();

                document.getElementById('currentConfig').textContent = JSON.stringify(data.mapping, null, 2);

                // 设置下拉框当前值
                Object.entries(data.mapping).forEach(([alias, model]) => {
                    const selectId = 'map-' + alias.replace(/\\./g, '-');
                    const select = document.getElementById(selectId);
                    if (select) select.value = model;
                });
            } catch (e) {
                console.error('Failed to load mapping:', e);
            }
        }

        async function saveMapping() {
            const status = document.getElementById('saveStatus');
            status.innerHTML = '<div class="status loading">保存中...</div>';

            const mapping = {};
            aliases.forEach(alias => {
                const selectId = 'map-' + alias.replace(/\\./g, '-');
                const select = document.getElementById(selectId);
                if (select && select.value) {
                    mapping[alias] = select.value;
                }
            });

            try {
                const res = await fetch('/api/mapping', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mapping })
                });

                const data = await res.json();
                if (data.success) {
                    status.innerHTML = '<div class="status success">✅ 保存成功！配置已立即生效。</div>';
                    document.getElementById('currentConfig').textContent = JSON.stringify(data.mapping, null, 2);
                } else {
                    status.innerHTML = '<div class="status error">保存失败: ' + (data.error || '未知错误') + '</div>';
                }
            } catch (e) {
                status.innerHTML = '<div class="status error">保存失败: ' + e.message + '</div>';
            }
        }

        async function autoDetect() {
            const status = document.getElementById('saveStatus');
            status.innerHTML = '<div class="status loading">正在自动检测最新模型...</div>';

            try {
                const res = await fetch('/api/auto-detect');
                const data = await res.json();

                if (data.success) {
                    status.innerHTML = '<div class="status success">✅ 自动检测完成！<br>Sonnet: ' + data.selected.latestSonnet + '<br>Opus: ' + data.selected.latestOpus + '<br>Haiku: ' + data.selected.latestHaiku + '</div>';

                    // 更新下拉框
                    Object.entries(data.mapping).forEach(([alias, model]) => {
                        const selectId = 'map-' + alias.replace(/\\./g, '-');
                        const select = document.getElementById(selectId);
                        if (select) select.value = model;
                    });

                    document.getElementById('currentConfig').textContent = JSON.stringify(data.mapping, null, 2);
                    availableModels = data.all_models;
                    updateModelList();
                    updateSelects();
                } else {
                    status.innerHTML = '<div class="status error">自动检测失败: ' + (data.error || '未知错误') + '</div>';
                }
            } catch (e) {
                status.innerHTML = '<div class="status error">自动检测失败: ' + e.message + '</div>';
            }
        }

        // 保存代理配置
        async function saveProxyConfig() {
            const status = document.getElementById('proxyStatus');
            status.innerHTML = '<div class="status loading">保存中...</div>';

            const baseUrl = document.getElementById('proxy-base-url').value.trim();
            const apiKey = document.getElementById('proxy-api-key').value.trim();

            const body = { baseUrl };
            if (apiKey) body.apiKey = apiKey;

            try {
                const res = await fetch('/api/proxy-config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });

                const data = await res.json();
                if (data.success) {
                    status.innerHTML = '<div class="status success">✅ 代理配置已保存并立即生效！</div>';
                    document.getElementById('proxy-api-key').value = '';
                    // 刷新模型列表
                    refreshModels();
                } else {
                    status.innerHTML = '<div class="status error">保存失败: ' + (data.error || '未知错误') + '</div>';
                }
            } catch (e) {
                status.innerHTML = '<div class="status error">保存失败: ' + e.message + '</div>';
            }
        }

        // 测试代理连接
        async function testProxyConnection() {
            const status = document.getElementById('proxyStatus');
            status.innerHTML = '<div class="status loading">正在测试连接...</div>';

            try {
                const res = await fetch('/api/proxy-models');
                const data = await res.json();

                if (data.error) {
                    status.innerHTML = '<div class="status error">连接失败: ' + data.error + '</div>';
                } else if (data.data && data.data.length > 0) {
                    status.innerHTML = '<div class="status success">✅ 连接成功！发现 ' + data.data.length + ' 个模型</div>';
                    availableModels = data.data.map(m => m.id);
                    updateModelList();
                    updateSelects();
                } else {
                    status.innerHTML = '<div class="status error">连接成功但未找到模型</div>';
                }
            } catch (e) {
                status.innerHTML = '<div class="status error">连接失败: ' + e.message + '</div>';
            }
        }

        // 页面加载时初始化
        refreshModels();
        loadCurrentMapping();
    </script>
</body>
</html>`

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
}

async function handleLogsPage(env: Env): Promise<Response> {
    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Claude Worker Proxy - 日志</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #1a1a2e; color: #eee; }
        h1 { color: #00d4ff; margin-bottom: 30px; }
        h2 { color: #00d4ff; font-size: 18px; margin-bottom: 15px; display: flex; align-items: center; gap: 10px; }
        .nav { margin-bottom: 30px; display: flex; gap: 20px; }
        .nav a { color: #888; text-decoration: none; font-size: 14px; }
        .nav a:hover { color: #00d4ff; }
        .card { background: #16213e; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
        .btn { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; transition: all 0.2s; }
        .btn-primary { background: #00d4ff; color: #000; }
        .btn-primary:hover { background: #00b8e6; }
        .btn-outline { background: transparent; border: 1px solid #00d4ff; color: #00d4ff; }
        .btn-outline:hover { background: #00d4ff22; }
        .btn-sm { padding: 6px 12px; font-size: 12px; }
        pre { background: #0f3460; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; }
        .log-table { width: 100%; border-collapse: collapse; }
        .log-table th, .log-table td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #2a3f5f; }
        .log-table th { color: #888; font-weight: normal; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
        .log-table td { font-size: 14px; }
        .log-table tr:hover { background: #1e2a4a; }
        .status { display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
        .status.success { background: #00ff8822; color: #00ff88; }
        .status.error { background: #e9456022; color: #e94560; }
        .model-tag { background: #0f3460; padding: 4px 10px; border-radius: 6px; font-family: monospace; font-size: 12px; }
        .copy-wrapper { position: relative; }
        .copy-btn { position: absolute; top: 10px; right: 10px; }
        .copied { background: #00ff88 !important; color: #000 !important; }
        .empty-state { text-align: center; padding: 40px; color: #666; }
        .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
        .time-ago { color: #888; font-size: 12px; }
        .error-text { color: #e94560; font-size: 12px; margin-top: 5px; }
    </style>
</head>
<body>
    <div class="nav">
        <a href="/">首页</a>
        <a href="/config">配置</a>
        <a href="/chat">测试</a>
        <a href="/logs">日志</a>
    </div>

    <h1>📋 请求日志</h1>

    <div class="card">
        <div class="header-row">
            <h2>📊 最近 5 条请求</h2>
            <button class="btn btn-outline btn-sm" onclick="refreshLogs()">刷新</button>
        </div>
        <div id="logsContainer">
            <div class="empty-state">加载中...</div>
        </div>
    </div>

    <div class="card" style="border: 2px solid #00d4ff;">
        <div class="header-row">
            <h2>✏️ 用户最后一次输入</h2>
            <button class="btn btn-primary btn-sm" id="copyUserInputBtn" onclick="copyUserInput()">一键复制</button>
        </div>
        <div class="copy-wrapper">
            <pre id="lastUserInput" style="max-height: 200px; white-space: pre-wrap;">加载中...</pre>
        </div>
        <p style="color: #888; font-size: 12px; margin-top: 10px;">💡 只包含用户在 Cursor 输入框中输入的内容，不含系统消息和上下文</p>
    </div>

    <div class="card">
        <div class="header-row">
            <h2>📝 最近一次请求内容</h2>
            <button class="btn btn-primary btn-sm" id="copyRequestBtn" onclick="copyRequest()">复制</button>
        </div>
        <div class="copy-wrapper">
            <pre id="lastRequest">加载中...</pre>
        </div>
    </div>

    <div class="card">
        <div class="header-row">
            <h2>📤 最近一次响应内容</h2>
            <button class="btn btn-primary btn-sm" id="copyResponseBtn" onclick="copyResponse()">复制</button>
        </div>
        <div class="copy-wrapper">
            <pre id="lastResponse">加载中...</pre>
        </div>
    </div>

    <div class="card">
        <h2>💡 说明</h2>
        <ul style="line-height: 2; color: #aaa; padding-left: 20px;">
            <li>日志会自动记录最近 5 条 API 请求</li>
            <li>最近一次请求和响应内容可直接复制用于调试</li>
            <li>流式响应不会保存完整内容（实时传输）</li>
            <li>如需查看更详细的实时日志，可在终端运行：<code style="background: #0f3460; padding: 2px 8px; border-radius: 4px; color: #00d4ff;">npx wrangler tail</code></li>
        </ul>
    </div>

    <script>
        async function refreshLogs() {
            try {
                const res = await fetch('/api/logs');
                const data = await res.json();

                // 渲染日志表格
                const container = document.getElementById('logsContainer');
                if (data.logs && data.logs.length > 0) {
                    let html = '<table class="log-table"><thead><tr>';
                    html += '<th>时间</th><th>请求 ID</th><th>模型</th><th>映射到</th><th>消息数</th><th>状态</th><th>耗时</th>';
                    html += '</tr></thead><tbody>';

                    for (const log of data.logs) {
                        const time = new Date(log.timestamp).toLocaleString('zh-CN');
                        const statusClass = log.status >= 200 && log.status < 300 ? 'success' : 'error';
                        const statusText = log.status >= 200 && log.status < 300 ? '成功' : '失败';

                        html += '<tr>';
                        html += '<td class="time-ago">' + time + '</td>';
                        html += '<td><code>' + log.id + '</code></td>';
                        html += '<td><span class="model-tag">' + log.model + '</span></td>';
                        html += '<td><span class="model-tag">' + log.mappedModel + '</span></td>';
                        html += '<td>' + log.messagesCount + (log.hasImages ? ' 📷' : '') + (log.stream ? ' 🌊' : '') + '</td>';
                        html += '<td><span class="status ' + statusClass + '">' + log.status + ' ' + statusText + '</span>';
                        if (log.error) {
                            html += '<div class="error-text">' + log.error + '</div>';
                        }
                        html += '</td>';
                        html += '<td>' + log.duration + 'ms</td>';
                        html += '</tr>';
                    }

                    html += '</tbody></table>';
                    container.innerHTML = html;
                } else {
                    container.innerHTML = '<div class="empty-state">暂无请求日志</div>';
                }

                // 渲染用户最后一次输入
                const userInputPre = document.getElementById('lastUserInput');
                if (data.lastUserInput) {
                    userInputPre.textContent = data.lastUserInput;
                } else {
                    userInputPre.textContent = '暂无用户输入记录';
                }

                // 渲染最近请求
                const requestPre = document.getElementById('lastRequest');
                if (data.lastRequest) {
                    requestPre.textContent = data.lastRequest;
                } else {
                    requestPre.textContent = '暂无请求记录';
                }

                // 渲染最近响应
                const responsePre = document.getElementById('lastResponse');
                if (data.lastResponse) {
                    responsePre.textContent = data.lastResponse;
                } else {
                    responsePre.textContent = '暂无响应记录';
                }

            } catch (e) {
                console.error('Failed to load logs:', e);
                document.getElementById('logsContainer').innerHTML =
                    '<div class="empty-state">加载失败: ' + e.message + '</div>';
            }
        }

        async function copyUserInput() {
            const content = document.getElementById('lastUserInput').textContent;
            if (!content || content === '暂无用户输入记录' || content === '加载中...') {
                return;
            }

            try {
                await navigator.clipboard.writeText(content);
                const btn = document.getElementById('copyUserInputBtn');
                btn.textContent = '已复制!';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.textContent = '一键复制';
                    btn.classList.remove('copied');
                }, 2000);
            } catch (e) {
                // 降级方案
                const textarea = document.createElement('textarea');
                textarea.value = content;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);

                const btn = document.getElementById('copyUserInputBtn');
                btn.textContent = '已复制!';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.textContent = '一键复制';
                    btn.classList.remove('copied');
                }, 2000);
            }
        }

        async function copyRequest() {
            const content = document.getElementById('lastRequest').textContent;
            if (!content || content === '暂无请求记录' || content === '加载中...') {
                return;
            }

            try {
                await navigator.clipboard.writeText(content);
                const btn = document.getElementById('copyRequestBtn');
                btn.textContent = '已复制!';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.textContent = '复制';
                    btn.classList.remove('copied');
                }, 2000);
            } catch (e) {
                // 降级方案
                const textarea = document.createElement('textarea');
                textarea.value = content;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);

                const btn = document.getElementById('copyRequestBtn');
                btn.textContent = '已复制!';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.textContent = '复制';
                    btn.classList.remove('copied');
                }, 2000);
            }
        }

        async function copyResponse() {
            const content = document.getElementById('lastResponse').textContent;
            if (!content || content === '暂无响应记录' || content === '加载中...') {
                return;
            }

            try {
                await navigator.clipboard.writeText(content);
                const btn = document.getElementById('copyResponseBtn');
                btn.textContent = '已复制!';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.textContent = '复制';
                    btn.classList.remove('copied');
                }, 2000);
            } catch (e) {
                // 降级方案
                const textarea = document.createElement('textarea');
                textarea.value = content;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);

                const btn = document.getElementById('copyResponseBtn');
                btn.textContent = '已复制!';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.textContent = '复制';
                    btn.classList.remove('copied');
                }, 2000);
            }
        }

        // 初始化
        refreshLogs();
    </script>
</body>
</html>`
    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
}

async function handleTestEndpoint(env: Env): Promise<Response> {
    const testRequest = {
        model: 'tinyy-model',
        messages: [{ role: 'user', content: 'Say "test ok" in 2 words' }],
        max_tokens: 10,
        stream: false
    }

    const claudeApiKey = env.CLAUDE_API_KEY
    const claudeBaseUrl = env.CLAUDE_BASE_URL || 'https://api.anthropic.com'

    const results: any = {
        timestamp: new Date().toISOString(),
        config: {
            claude_base_url: claudeBaseUrl,
            api_key_set: !!claudeApiKey,
            api_key_preview: claudeApiKey ? claudeApiKey.slice(0, 10) + '...' : 'NOT SET'
        },
        test_request: testRequest,
        steps: []
    }

    try {
        // Step 1: 创建 Claude 请求
        results.steps.push({ step: 1, name: 'Create Claude request', status: 'started' })

        const provider = new claude.ClaudeProvider()
        const fakeRequest = new Request('http://localhost/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testRequest)
        })

        const claudeRequest = await provider.convertToProviderRequest(fakeRequest, claudeBaseUrl, claudeApiKey || '')
        const claudeBody = await claudeRequest.clone().json()

        results.steps[0].status = 'success'
        results.steps[0].claude_request = {
            url: claudeRequest.url,
            method: claudeRequest.method,
            body: claudeBody
        }

        // Step 2: 发送请求
        results.steps.push({ step: 2, name: 'Send to Claude API', status: 'started' })
        const startTime = Date.now()
        const claudeResponse = await fetch(claudeRequest)
        const duration = Date.now() - startTime

        results.steps[1].status = claudeResponse.ok ? 'success' : 'failed'
        results.steps[1].response_status = claudeResponse.status
        results.steps[1].duration_ms = duration

        // Step 3: 解析响应
        results.steps.push({ step: 3, name: 'Parse response', status: 'started' })
        const responseText = await claudeResponse.text()

        try {
            results.claude_response = JSON.parse(responseText)
            results.steps[2].status = 'success'
        } catch {
            results.claude_response_raw = responseText.slice(0, 500)
            results.steps[2].status = 'failed'
            results.steps[2].error = 'Failed to parse JSON response'
        }

        results.overall_status = claudeResponse.ok ? 'SUCCESS' : 'FAILED'
    } catch (error) {
        results.overall_status = 'ERROR'
        results.error = error instanceof Error ? error.message : 'Unknown error'
    }

    return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' }
    })
}

function handleModels(): Response {
    const models = {
        object: 'list',
        data: [
            {
                id: 'tinyy-model',
                object: 'model',
                created: 1700000000,
                owned_by: 'anthropic',
                permission: [],
                root: 'claude-sonnet-4-5-20250929',
                parent: null
            },
            {
                id: 'bigger-model',
                object: 'model',
                created: 1700000000,
                owned_by: 'anthropic',
                permission: [],
                root: 'claude-opus-4-5-20251101',
                parent: null
            },
            {
                id: 'gpt-4',
                object: 'model',
                created: 1700000000,
                owned_by: 'anthropic',
                permission: [],
                root: 'claude-opus-4-5-20251101',
                parent: null
            },
            {
                id: 'gpt-4o',
                object: 'model',
                created: 1700000000,
                owned_by: 'anthropic',
                permission: [],
                root: 'claude-sonnet-4-5-20250929',
                parent: null
            },
            {
                id: 'gpt-3.5-turbo',
                object: 'model',
                created: 1700000000,
                owned_by: 'anthropic',
                permission: [],
                root: 'claude-haiku-4-5-20251001',
                parent: null
            }
        ]
    }
    return new Response(JSON.stringify(models), {
        headers: { 'Content-Type': 'application/json' }
    })
}

function parsePath(url: URL): { typeParam?: string; baseUrl?: string; err?: Response } {
    const pathParts = url.pathname.split('/').filter(part => part !== '')
    if (pathParts.length < 3) {
        return {
            err: new Response(
                JSON.stringify({
                    error: {
                        type: 'invalid_request',
                        message: `Invalid path: ${url.pathname}. For OpenAI compatible API, use /v1/chat/completions or /v1/models. For Claude to Provider, use /{type}/{provider_url}/v1/messages`
                    }
                }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            )
        }
    }
    const lastTwoParts = pathParts.slice(-2)
    if (lastTwoParts[0] !== 'v1' || lastTwoParts[1] !== 'messages') {
        return { err: new Response('Path must end with /v1/messages', { status: 404 }) }
    }

    const typeParam = pathParts[0]
    const providerUrlParts = pathParts.slice(1, -2)

    // [..., 'https:', ...] ==> [..., 'https:/', ...]
    if (pathParts[1] && pathParts[1].startsWith('http')) {
        pathParts[1] = pathParts[1] + '/'
    }

    const baseUrl = providerUrlParts.join('/')
    if (!typeParam || !baseUrl) {
        return { err: new Response('Missing type or provider_url in path', { status: 400 }) }
    }

    return { typeParam, baseUrl }
}

function getApiKey(headers: Headers): { apiKey?: string; mutatedHeaders?: Headers; err?: Response } {
    const mutatedHeaders = new Headers(headers)
    let apiKey = headers.get('x-api-key')
    if (apiKey) {
        mutatedHeaders.delete('x-api-key')
    } else {
        apiKey = mutatedHeaders.get('authorization')
        if (apiKey) {
            mutatedHeaders.delete('authorization')
        }
    }

    if (!apiKey) {
        return { err: new Response('Missing x-api-key or authorization header', { status: 401 }) }
    }

    return { apiKey, mutatedHeaders }
}
