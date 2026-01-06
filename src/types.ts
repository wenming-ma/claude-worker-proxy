export interface JsonSchema {
    type?: 'object' | 'string' | 'number' | 'boolean' | 'array'
    properties?: { [key: string]: JsonSchema }
    required?: string[]
    description?: string
    items?: JsonSchema
}

export interface ClaudeTool {
    name: string
    description: string
    input_schema: JsonSchema
}

export type ClaudeContent =
    | string
    | Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: any }
          | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
          | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
      >

export interface ClaudeMessage {
    role: 'user' | 'assistant'
    content: ClaudeContent
}

export interface ClaudeRequest {
    model: string
    messages: ClaudeMessage[]
    max_tokens?: number
    temperature?: number
    stream?: boolean
    tools?: ClaudeTool[]
    system?: string
}

export interface ClaudeResponse {
    id: string
    type: 'message'
    role: 'assistant'
    content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: any }>
    stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens'
    usage?: {
        input_tokens: number
        output_tokens: number
    }
}

export interface GeminiFunctionDeclaration {
    name: string
    description: string
    parameters: JsonSchema
}

export interface GeminiTool {
    functionDeclarations: GeminiFunctionDeclaration[]
}

export type GeminiPart =
    | { text: string }
    | { functionCall: { name: string; args: any } }
    | { functionResponse: { name: string; response: any } }

export interface GeminiContent {
    parts: GeminiPart[]
    role?: 'user' | 'model' | 'tool'
}

export interface GeminiRequest {
    model?: string
    contents: GeminiContent[]
    tools?: GeminiTool[]
    generationConfig?: {
        temperature?: number
        maxOutputTokens?: number
    }
}

export interface GeminiCandidate {
    content: {
        parts: GeminiPart[]
        role: 'model'
    }
    finishReason?: string
}

export interface GeminiResponse {
    candidates: GeminiCandidate[]
    usageMetadata?: {
        promptTokenCount: number
        candidatesTokenCount: number
        totalTokenCount: number
    }
}

export interface ClaudeStreamEvent {
    type:
        | 'message_start'
        | 'content_block_start'
        | 'content_block_delta'
        | 'content_block_stop'
        | 'message_delta'
        | 'message_stop'
    message?: Partial<ClaudeResponse>
    content_block?: {
        type: 'text' | 'tool_use'
        text?: string
        id?: string
        name?: string
        input?: any
    }
    delta?: {
        type: 'text_delta' | 'input_json_delta'
        text?: string
        partial_json?: string
    }
    index?: number
    usage?: {
        input_tokens: number
        output_tokens: number
    }
}

// OpenAI 多模态内容部分
export type OpenAIContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content?: string | OpenAIContentPart[] | null
    tool_calls?: OpenAIToolCall[]
    tool_call_id?: string
}

export interface OpenAIToolCall {
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string
    }
}

export interface OpenAITool {
    type: 'function'
    function: {
        name: string
        description?: string
        parameters?: any
    }
}

export interface OpenAIRequest {
    model: string
    messages: OpenAIMessage[]
    tools?: OpenAITool[]
    temperature?: number
    max_tokens?: number
    stream?: boolean
}

export interface OpenAIChoice {
    index: number
    message: OpenAIMessage
    finish_reason: string | null
}

export interface OpenAIResponse {
    id: string
    object: string
    created: number
    model: string
    choices: OpenAIChoice[]
    usage?: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
    }
}

export interface OpenAIStreamChoice {
    index: number
    delta: {
        role?: string
        content?: string
        tool_calls?: Array<{
            index: number
            id?: string
            type?: 'function'
            function?: {
                name?: string
                arguments?: string
            }
        }>
    }
    finish_reason?: string | null
}

export interface OpenAIStreamResponse {
    id: string
    object: string
    created: number
    model: string
    choices: OpenAIStreamChoice[]
}
