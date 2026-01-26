import * as types from './types'
import * as provider from './provider'
import * as utils from './utils'
import Anthropic from '@anthropic-ai/sdk'

// 默认模型名称映射表（作为后备）
export const DEFAULT_MODEL_MAPPING: { [key: string]: string } = {
    // Cursor 配置的模型名（思考模型）
    'tinyy-model': 'claude-sonnet-4-5-20250929',
    'bigger-model': 'claude-opus-4-5-20251101',

    // 通用兼容性映射
    'gpt-4': 'claude-opus-4-5-20251101',
    'gpt-4o': 'claude-sonnet-4-5-20250929',
    'gpt-4-turbo': 'claude-sonnet-4-5-20250929',
    'gpt-3.5-turbo': 'claude-haiku-4-5-20251001'
}

// 需要启用思考模式的模型别名
const THINKING_MODELS = new Set(['tinyy-model', 'bigger-model'])

// 当前使用的模型映射（可动态更新）
let currentModelMapping: { [key: string]: string } = { ...DEFAULT_MODEL_MAPPING }

// 设置模型映射
export function setModelMapping(mapping: { [key: string]: string }) {
    currentModelMapping = { ...DEFAULT_MODEL_MAPPING, ...mapping }
}

// 获取当前模型映射
export function getModelMapping(): { [key: string]: string } {
    return { ...currentModelMapping }
}

function mapModelName(inputModel: string): string {
    // 如果在映射表中，使用映射
    if (currentModelMapping[inputModel]) {
        return currentModelMapping[inputModel]
    }
    // 否则直接使用原始模型名
    return inputModel
}

export class ClaudeProvider implements provider.Provider {
    async convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request> {
        const openaiRequest = (await request.json()) as types.OpenAIRequest
        // system 消息已在 convertMessages 中合并到第一个 user 消息，不再单独使用
        const { messages } = this.convertMessages(openaiRequest.messages)

        // 应用模型名称映射
        const mappedModel = mapModelName(openaiRequest.model)

        // 检查是否需要启用思考模式
        const enableThinking = THINKING_MODELS.has(openaiRequest.model)

        const claudeRequest: types.ClaudeRequest = {
            model: mappedModel,
            messages,
            // 思考模式需要更大的 max_tokens
            max_tokens: enableThinking
                ? Math.max(openaiRequest.max_tokens || 16000, 16000)
                : openaiRequest.max_tokens || 4096,
            stream: openaiRequest.stream
        }

        // 为思考模型启用 thinking 参数
        if (enableThinking) {
            claudeRequest.thinking = {
                type: 'enabled',
                budget_tokens: 10000
            }
        }

        // 注意：不再使用顶级 system 字段，因为某些代理服务不支持（如 crs.itssx.com）
        // system 消息已在 convertMessages 中合并到第一个 user 消息中

        // 注意：不传递 temperature 参数，因为某些代理服务（如 imds.ai）
        // 在 temperature != 1 时会返回 502 错误
        // Claude 默认使用合适的 temperature，所以不传递也没问题

        if (openaiRequest.tools && openaiRequest.tools.length > 0) {
            claudeRequest.tools = openaiRequest.tools.map(tool => ({
                name: tool.function.name,
                description: tool.function.description || '',
                input_schema: utils.cleanJsonSchema(tool.function.parameters || {})
            }))
        }

        const finalUrl = utils.buildUrl(baseUrl, 'v1/messages')
        const headers = new Headers(request.headers)
        headers.set('x-api-key', apiKey)
        headers.set('anthropic-version', '2023-06-01')
        headers.set('Content-Type', 'application/json')

        return new Request(finalUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(claudeRequest)
        })
    }

    async convertToClaudeResponse(claudeResponse: Response): Promise<Response> {
        if (!claudeResponse.ok) {
            return claudeResponse
        }

        const contentType = claudeResponse.headers.get('content-type') || ''
        const isStream = contentType.includes('text/event-stream')

        if (isStream) {
            return this.convertStreamResponse(claudeResponse)
        } else {
            return this.convertNormalResponse(claudeResponse)
        }
    }

    private convertMessages(openaiMessages: types.OpenAIMessage[]): {
        messages: types.ClaudeMessage[]
        system?: string
    } {
        const claudeMessages: types.ClaudeMessage[] = []
        const systemMessages: string[] = []

        for (const message of openaiMessages) {
            // 收集 system 消息
            if (message.role === 'system') {
                if (typeof message.content === 'string') {
                    systemMessages.push(message.content)
                }
                continue
            }

            // 处理 tool 消息 - 需要合并连续的 tool_result 到一个 user 消息中
            // Claude API 要求消息必须交替（user → assistant → user）
            if (message.role === 'tool') {
                // 提取 tool 消息的实际内容
                // Cursor 可能发送数组格式: [{"type":"text","text":"..."}]
                let toolContent = ''
                if (typeof message.content === 'string') {
                    toolContent = message.content
                } else if (Array.isArray(message.content)) {
                    // 提取所有 text 类型的内容
                    toolContent = message.content
                        .filter((item: any) => item.type === 'text')
                        .map((item: any) => item.text || '')
                        .join('\n')
                }

                console.log('[Tool] id:', message.tool_call_id, 'content_len:', toolContent.length)

                const toolResult = {
                    type: 'tool_result' as const,
                    tool_use_id: message.tool_call_id!,
                    content: toolContent
                }

                // 检查上一个消息是否是 user 且包含 tool_result
                const lastMessage = claudeMessages[claudeMessages.length - 1]
                if (
                    lastMessage &&
                    lastMessage.role === 'user' &&
                    Array.isArray(lastMessage.content) &&
                    lastMessage.content.some((c: any) => c.type === 'tool_result')
                ) {
                    // 合并到上一个 user 消息中
                    ;(lastMessage.content as any[]).push(toolResult)
                } else {
                    // 创建新的 user 消息
                    claudeMessages.push({
                        role: 'user',
                        content: [toolResult]
                    })
                }
                continue
            }

            // 处理 user 和 assistant 消息
            const content: Array<
                | { type: 'text'; text: string }
                | { type: 'tool_use'; id: string; name: string; input: any }
                | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
            > = []

            // 处理消息内容 - 可能是字符串或数组
            if (message.content) {
                if (typeof message.content === 'string') {
                    // 简单文本消息
                    content.push({
                        type: 'text',
                        text: message.content
                    })
                } else if (Array.isArray(message.content)) {
                    // 多模态消息（包含图片等）
                    for (const part of message.content) {
                        if (part.type === 'text') {
                            content.push({
                                type: 'text',
                                text: part.text || ''
                            })
                        } else if (part.type === 'image_url' && part.image_url) {
                            // 转换 OpenAI 图片格式到 Claude 格式
                            const imageUrl = part.image_url.url || ''
                            if (imageUrl.startsWith('data:')) {
                                // Base64 编码的图片
                                const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/)
                                if (matches) {
                                    content.push({
                                        type: 'image',
                                        source: {
                                            type: 'base64',
                                            media_type: matches[1],
                                            data: matches[2]
                                        }
                                    })
                                }
                            } else {
                                // URL 图片 - Claude 需要 base64，这里先作为文本提示
                                content.push({
                                    type: 'text',
                                    text: `[Image URL: ${imageUrl}]`
                                })
                            }
                        }
                    }
                }
            }

            if (message.tool_calls) {
                for (const toolCall of message.tool_calls) {
                    content.push({
                        type: 'tool_use',
                        id: toolCall.id,
                        name: toolCall.function.name,
                        input: JSON.parse(toolCall.function.arguments)
                    })
                }
            }

            if (content.length > 0) {
                claudeMessages.push({
                    role: message.role === 'assistant' ? 'assistant' : 'user',
                    content: content.length === 1 && content[0].type === 'text' ? content[0].text : content
                })
            }
        }

        // 如果有 system 消息，将其合并到第一个 user 消息中
        // 这是为了兼容不支持顶级 system 字段的代理服务（如 crs.itssx.com）
        const systemPrompt = systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined
        if (systemPrompt && claudeMessages.length > 0) {
            const firstUserIndex = claudeMessages.findIndex(m => m.role === 'user')
            if (firstUserIndex !== -1) {
                const firstUserMsg = claudeMessages[firstUserIndex]
                if (typeof firstUserMsg.content === 'string') {
                    // 将 system 消息前置到第一个 user 消息
                    firstUserMsg.content = `[System Instructions]\n${systemPrompt}\n\n[User Message]\n${firstUserMsg.content}`
                } else if (Array.isArray(firstUserMsg.content)) {
                    // 对于数组格式的内容，在开头插入 system 文本
                    firstUserMsg.content.unshift({
                        type: 'text',
                        text: `[System Instructions]\n${systemPrompt}\n\n[User Message]`
                    })
                }
            }
        }

        return {
            messages: claudeMessages,
            // 不再返回顶级 system 字段，因为某些代理不支持
            system: undefined
        }
    }

    private async convertNormalResponse(claudeResponse: Response): Promise<Response> {
        const claudeData = (await claudeResponse.json()) as types.ClaudeResponse

        const openaiResponse: types.OpenAIResponse = {
            id: claudeData.id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: claudeData.id,
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: null
                    },
                    finish_reason: this.convertStopReason(claudeData.stop_reason)
                }
            ]
        }

        if (claudeData.usage) {
            openaiResponse.usage = {
                prompt_tokens: claudeData.usage.input_tokens,
                completion_tokens: claudeData.usage.output_tokens,
                total_tokens: claudeData.usage.input_tokens + claudeData.usage.output_tokens
            }
        }

        let textContent = ''
        let thinkingContent = ''
        const toolCalls: types.OpenAIToolCall[] = []

        for (const content of claudeData.content) {
            if (content.type === 'text') {
                textContent += content.text
            } else if (content.type === 'thinking') {
                // 收集 thinking 内容
                thinkingContent += content.thinking
            } else if (content.type === 'tool_use') {
                toolCalls.push({
                    id: content.id,
                    type: 'function',
                    function: {
                        name: content.name,
                        arguments: JSON.stringify(content.input)
                    }
                })
            }
        }

        // 如果有 thinking 内容，将其放在回答前面
        if (thinkingContent) {
            textContent = `<thinking>\n${thinkingContent}\n</thinking>\n\n${textContent}`
        }

        if (textContent) {
            openaiResponse.choices[0].message.content = textContent
        }

        if (toolCalls.length > 0) {
            openaiResponse.choices[0].message.tool_calls = toolCalls
        }

        return new Response(JSON.stringify(openaiResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        })
    }

    private async convertStreamResponse(claudeResponse: Response): Promise<Response> {
        const stream = new ReadableStream({
            async start(controller) {
                const reader = claudeResponse.body?.getReader()
                if (!reader) {
                    controller.close()
                    return
                }

                const decoder = new TextDecoder()
                const encoder = new TextEncoder()
                let buffer = ''
                let responseId = utils.generateId()
                let model = 'claude'
                let isFirstChunk = true
                let textContent = ''
                let inThinkingBlock = false
                const toolCalls: Array<{
                    index: number
                    id: string
                    type: 'function'
                    function: { name: string; arguments: string }
                }> = []

                let sentDone = false
                let sentFinishReason = false

                try {
                    while (true) {
                        const { done, value } = await reader.read()
                        if (done) break

                        const chunk = buffer + decoder.decode(value, { stream: true })
                        const lines = chunk.split('\n')
                        buffer = lines.pop() || ''

                        for (const line of lines) {
                            if (!line.trim() || !line.startsWith('data: ')) continue

                            const jsonStr = line.slice(6)
                            if (jsonStr === '[DONE]') continue

                            try {
                                const event = JSON.parse(jsonStr) as types.ClaudeStreamEvent

                                if (event.type === 'message_start') {
                                    if (event.message?.id) {
                                        responseId = event.message.id
                                    }
                                    // 发送第一个 OpenAI 流式事件
                                    const openaiChunk: types.OpenAIStreamResponse = {
                                        id: responseId,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model,
                                        choices: [
                                            {
                                                index: 0,
                                                delta: { role: 'assistant' },
                                                finish_reason: null
                                            }
                                        ]
                                    }
                                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`))
                                } else if (event.type === 'content_block_start') {
                                    if (event.content_block?.type === 'tool_use') {
                                        // 开始工具调用
                                        const toolCall = {
                                            index: toolCalls.length,
                                            id: event.content_block.id || utils.generateId(),
                                            type: 'function' as const,
                                            function: {
                                                name: event.content_block.name || '',
                                                arguments: ''
                                            }
                                        }
                                        toolCalls.push(toolCall)
                                    } else if (event.content_block?.type === 'thinking') {
                                        // 开始 thinking 块，发送开始标签
                                        inThinkingBlock = true
                                        const openaiChunk: types.OpenAIStreamResponse = {
                                            id: responseId,
                                            object: 'chat.completion.chunk',
                                            created: Math.floor(Date.now() / 1000),
                                            model,
                                            choices: [
                                                {
                                                    index: 0,
                                                    delta: { content: '<thinking>\n' },
                                                    finish_reason: null
                                                }
                                            ]
                                        }
                                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`))
                                    }
                                } else if (event.type === 'content_block_delta') {
                                    if (event.delta?.type === 'text_delta' && event.delta.text) {
                                        // 文本内容
                                        textContent += event.delta.text
                                        const openaiChunk: types.OpenAIStreamResponse = {
                                            id: responseId,
                                            object: 'chat.completion.chunk',
                                            created: Math.floor(Date.now() / 1000),
                                            model,
                                            choices: [
                                                {
                                                    index: 0,
                                                    delta: { content: event.delta.text },
                                                    finish_reason: null
                                                }
                                            ]
                                        }
                                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`))
                                    } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
                                        // thinking 内容流式输出
                                        const openaiChunk: types.OpenAIStreamResponse = {
                                            id: responseId,
                                            object: 'chat.completion.chunk',
                                            created: Math.floor(Date.now() / 1000),
                                            model,
                                            choices: [
                                                {
                                                    index: 0,
                                                    delta: { content: event.delta.thinking },
                                                    finish_reason: null
                                                }
                                            ]
                                        }
                                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`))
                                    } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                                        // 工具调用参数
                                        if (toolCalls.length > 0) {
                                            toolCalls[toolCalls.length - 1].function.arguments +=
                                                event.delta.partial_json
                                        }
                                    }
                                } else if (event.type === 'content_block_stop') {
                                    // 如果在 thinking 块中，发送结束标签
                                    if (inThinkingBlock) {
                                        inThinkingBlock = false
                                        const openaiChunk: types.OpenAIStreamResponse = {
                                            id: responseId,
                                            object: 'chat.completion.chunk',
                                            created: Math.floor(Date.now() / 1000),
                                            model,
                                            choices: [
                                                {
                                                    index: 0,
                                                    delta: { content: '\n</thinking>\n\n' },
                                                    finish_reason: null
                                                }
                                            ]
                                        }
                                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`))
                                    }
                                    // 如果有工具调用，发送它
                                    if (toolCalls.length > 0) {
                                        const lastToolCall = toolCalls[toolCalls.length - 1]
                                        const openaiChunk: types.OpenAIStreamResponse = {
                                            id: responseId,
                                            object: 'chat.completion.chunk',
                                            created: Math.floor(Date.now() / 1000),
                                            model,
                                            choices: [
                                                {
                                                    index: 0,
                                                    delta: {
                                                        tool_calls: [
                                                            {
                                                                index: lastToolCall.index,
                                                                id: lastToolCall.id,
                                                                type: 'function',
                                                                function: {
                                                                    name: lastToolCall.function.name,
                                                                    arguments: lastToolCall.function.arguments
                                                                }
                                                            }
                                                        ]
                                                    },
                                                    finish_reason: null
                                                }
                                            ]
                                        }
                                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`))
                                    }
                                } else if (event.type === 'message_delta') {
                                    // 消息结束
                                    const finishReason =
                                        event.delta && 'stop_reason' in event.delta
                                            ? convertStopReason(event.delta.stop_reason as string)
                                            : 'stop'
                                    const openaiChunk: types.OpenAIStreamResponse = {
                                        id: responseId,
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model,
                                        choices: [
                                            {
                                                index: 0,
                                                delta: {},
                                                finish_reason: finishReason
                                            }
                                        ]
                                    }
                                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`))
                                    sentFinishReason = true
                                } else if (event.type === 'message_stop') {
                                    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                                    sentDone = true
                                }
                            } catch (e) {
                                console.error('Error parsing Claude stream event:', e)
                            }
                        }
                    }

                    // 处理 buffer 中剩余的数据
                    if (buffer.trim() && buffer.startsWith('data: ')) {
                        const jsonStr = buffer.slice(6)
                        if (jsonStr !== '[DONE]') {
                            try {
                                const event = JSON.parse(jsonStr) as types.ClaudeStreamEvent
                                if (event.type === 'message_stop') {
                                    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                                    sentDone = true
                                }
                            } catch {
                                // 忽略解析错误
                            }
                        }
                    }

                    // 确保发送 finish_reason 和 [DONE]
                    if (!sentFinishReason) {
                        const openaiChunk: types.OpenAIStreamResponse = {
                            id: responseId,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model,
                            choices: [
                                {
                                    index: 0,
                                    delta: {},
                                    finish_reason: 'stop'
                                }
                            ]
                        }
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`))
                    }

                    if (!sentDone) {
                        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                    }
                } finally {
                    reader.releaseLock()
                    controller.close()
                }
            }
        })

        return new Response(stream, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            }
        })

        function convertStopReason(claudeStopReason?: string): string | null {
            switch (claudeStopReason) {
                case 'end_turn':
                    return 'stop'
                case 'tool_use':
                    return 'tool_calls'
                case 'max_tokens':
                    return 'length'
                default:
                    return null
            }
        }
    }

    private convertStopReason(claudeStopReason?: string): string | null {
        switch (claudeStopReason) {
            case 'end_turn':
                return 'stop'
            case 'tool_use':
                return 'tool_calls'
            case 'max_tokens':
                return 'length'
            default:
                return null
        }
    }

    /**
     * 使用 Anthropic SDK 处理流式响应
     * 比手动 SSE 解析更稳定可靠
     */
    async convertStreamWithSDK(baseUrl: string, apiKey: string, openaiRequest: types.OpenAIRequest): Promise<Response> {
        const { messages } = this.convertMessages(openaiRequest.messages)
        const mappedModel = mapModelName(openaiRequest.model)
        const enableThinking = THINKING_MODELS.has(openaiRequest.model)

        // 构建 Claude 请求参数
        const claudeParams: Anthropic.MessageCreateParams = {
            model: mappedModel,
            messages: messages as Anthropic.MessageParam[],
            max_tokens: enableThinking
                ? Math.max(openaiRequest.max_tokens || 16000, 16000)
                : openaiRequest.max_tokens || 4096,
            stream: true
        }

        // 为思考模型启用 thinking 参数
        // 注意：当有 tool_result 时禁用 thinking，因为某些代理服务不支持这种组合
        const hasToolResult = messages.some(
            (m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result')
        )
        if (enableThinking && !hasToolResult) {
            ;(claudeParams as any).thinking = {
                type: 'enabled',
                budget_tokens: 10000
            }
        }

        // 添加工具
        if (openaiRequest.tools && openaiRequest.tools.length > 0) {
            claudeParams.tools = openaiRequest.tools.map(tool => ({
                name: tool.function.name,
                description: tool.function.description || '',
                input_schema: utils.cleanJsonSchema(tool.function.parameters || {}) as Anthropic.Tool.InputSchema
            }))
        }

        // 创建 SDK 客户端
        const client = new Anthropic({
            apiKey,
            baseURL: baseUrl
        })

        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()
        const encoder = new TextEncoder()

        // 后台处理流式事件
        ;(async () => {
            let eventCount = 0
            let lastEventType = ''
            const startTime = Date.now()

            try {
                console.log('[SDK Stream] Starting stream request')
                console.log(`[SDK Stream] Model: ${claudeParams.model}, Messages: ${claudeParams.messages.length}, MaxTokens: ${claudeParams.max_tokens}`)
                console.log(`[SDK Stream] Tools: ${claudeParams.tools?.length || 0}, Thinking: ${(claudeParams as any).thinking ? 'enabled' : 'disabled'}`)
                // 检查消息类型
                for (let i = 0; i < claudeParams.messages.length; i++) {
                    const msg = claudeParams.messages[i]
                    const contentType = Array.isArray(msg.content)
                        ? msg.content.map((c: any) => c.type).join(',')
                        : 'text'
                    console.log(`[SDK Stream] Message[${i}]: role=${msg.role}, content_types=${contentType}`)
                }
                // 打印完整的 tool_result 内容（仅用于调试）
                for (const msg of claudeParams.messages) {
                    if (Array.isArray(msg.content)) {
                        for (const block of msg.content as any[]) {
                            if (block.type === 'tool_result') {
                                const contentPreview =
                                    typeof block.content === 'string'
                                        ? block.content.substring(0, 100)
                                        : JSON.stringify(block.content).substring(0, 100)
                                console.log(
                                    `[SDK Stream] tool_result: id=${block.tool_use_id}, content_len=${block.content?.length || 0}, preview=${contentPreview}...`
                                )
                            }
                        }
                    }
                }
                const stream = client.messages.stream(claudeParams)
                const responseId = utils.generateId()
                const model = mappedModel
                let inThinkingBlock = false
                let toolCallIndex = 0
                let currentToolCall: { id: string; name: string; arguments: string } | null = null

                // 发送初始角色事件
                const initChunk = {
                    id: responseId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
                }
                await writer.write(encoder.encode(`data: ${JSON.stringify(initChunk)}\n\n`))
                console.log('[SDK Stream] Sent initial chunk')

                // 处理流式事件
                for await (const event of stream) {
                    eventCount++
                    lastEventType = event.type
                    if (eventCount % 10 === 0) {
                        console.log(`[SDK Stream] Processed ${eventCount} events, last: ${lastEventType}`)
                    }

                    if (event.type === 'content_block_start') {
                        const block = event.content_block
                        if (block.type === 'thinking') {
                            inThinkingBlock = true
                            const chunk = {
                                id: responseId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model,
                                choices: [{ index: 0, delta: { content: '<thinking>\n' }, finish_reason: null }]
                            }
                            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                        } else if (block.type === 'tool_use') {
                            currentToolCall = {
                                id: block.id,
                                name: block.name,
                                arguments: ''
                            }
                        }
                    } else if (event.type === 'content_block_delta') {
                        const delta = event.delta
                        if (delta.type === 'text_delta') {
                            const chunk = {
                                id: responseId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model,
                                choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }]
                            }
                            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                        } else if (delta.type === 'thinking_delta') {
                            const chunk = {
                                id: responseId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model,
                                choices: [{ index: 0, delta: { content: delta.thinking }, finish_reason: null }]
                            }
                            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                        } else if (delta.type === 'input_json_delta' && currentToolCall) {
                            currentToolCall.arguments += delta.partial_json
                        }
                    } else if (event.type === 'content_block_stop') {
                        if (inThinkingBlock) {
                            inThinkingBlock = false
                            const chunk = {
                                id: responseId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model,
                                choices: [{ index: 0, delta: { content: '\n</thinking>\n\n' }, finish_reason: null }]
                            }
                            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                        }
                        if (currentToolCall) {
                            const chunk = {
                                id: responseId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model,
                                choices: [
                                    {
                                        index: 0,
                                        delta: {
                                            tool_calls: [
                                                {
                                                    index: toolCallIndex++,
                                                    id: currentToolCall.id,
                                                    type: 'function',
                                                    function: {
                                                        name: currentToolCall.name,
                                                        arguments: currentToolCall.arguments
                                                    }
                                                }
                                            ]
                                        },
                                        finish_reason: null
                                    }
                                ]
                            }
                            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                            currentToolCall = null
                        }
                    }
                }

                // 获取最终消息以获取 stop_reason
                console.log(`[SDK Stream] Stream loop completed, total events: ${eventCount}, duration: ${Date.now() - startTime}ms`)
                const finalMessage = await stream.finalMessage()
                const finishReason = this.convertStopReason(finalMessage.stop_reason) || 'stop'
                console.log(`[SDK Stream] Final message stop_reason: ${finalMessage.stop_reason}, mapped to: ${finishReason}`)

                // 发送 finish_reason
                const finishChunk = {
                    id: responseId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
                }
                await writer.write(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`))

                // 发送 [DONE]
                await writer.write(encoder.encode('data: [DONE]\n\n'))
                console.log(`[SDK Stream] Completed successfully, total duration: ${Date.now() - startTime}ms`)
            } catch (error) {
                const duration = Date.now() - startTime
                console.error(`[SDK Stream] Error after ${eventCount} events, ${duration}ms:`, error)
                console.error(`[SDK Stream] Last event type: ${lastEventType}`)
                // 发送错误后的 [DONE]
                try {
                    await writer.write(encoder.encode('data: [DONE]\n\n'))
                } catch (writeError) {
                    console.error('[SDK Stream] Failed to write DONE:', writeError)
                }
            } finally {
                try {
                    await writer.close()
                } catch (closeError) {
                    console.error('[SDK Stream] Failed to close writer:', closeError)
                }
            }
        })()

        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            }
        })
    }
}
