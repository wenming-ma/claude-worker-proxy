import * as types from './types'
import * as provider from './provider'
import * as utils from './utils'

// 默认模型名称映射表（作为后备）
export const DEFAULT_MODEL_MAPPING: { [key: string]: string } = {
    // Cursor 配置的模型名
    'tinyy-model': 'claude-sonnet-4-5-20250929',
    'bigger-model': 'claude-opus-4-5-20251101',

    // 通用兼容性映射
    'gpt-4': 'claude-opus-4-5-20251101',
    'gpt-4o': 'claude-sonnet-4-5-20250929',
    'gpt-4-turbo': 'claude-sonnet-4-5-20250929',
    'gpt-3.5-turbo': 'claude-haiku-4-5-20251001'
}

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
        const { messages, system } = this.convertMessages(openaiRequest.messages)

        // 应用模型名称映射
        const mappedModel = mapModelName(openaiRequest.model)

        const claudeRequest: types.ClaudeRequest = {
            model: mappedModel,
            messages,
            max_tokens: openaiRequest.max_tokens || 4096,
            stream: openaiRequest.stream
        }

        if (system) {
            claudeRequest.system = system
        }

        if (openaiRequest.temperature !== undefined) {
            claudeRequest.temperature = openaiRequest.temperature
        }

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

            // 处理 tool 消息
            if (message.role === 'tool') {
                claudeMessages.push({
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: message.tool_call_id!,
                            content: typeof message.content === 'string' ? message.content : ''
                        }
                    ]
                })
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

        return {
            messages: claudeMessages,
            system: systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined
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
        const toolCalls: types.OpenAIToolCall[] = []

        for (const content of claudeData.content) {
            if (content.type === 'text') {
                textContent += content.text
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
                const toolCalls: Array<{
                    index: number
                    id: string
                    type: 'function'
                    function: { name: string; arguments: string }
                }> = []

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
                                    } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                                        // 工具调用参数
                                        if (toolCalls.length > 0) {
                                            toolCalls[toolCalls.length - 1].function.arguments +=
                                                event.delta.partial_json
                                        }
                                    }
                                } else if (event.type === 'content_block_stop') {
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
                                } else if (event.type === 'message_stop') {
                                    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                                }
                            } catch (e) {
                                console.error('Error parsing Claude stream event:', e)
                            }
                        }
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
}
