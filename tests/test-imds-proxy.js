const https = require('https')

const proxy = {
    name: 'imds.ai',
    baseUrl: 'https://as086nwvpbrnivunc.imds.ai/api',
    apiKey: 'cr_792fe201363ff3d74cd3e817204c40dda90b1ac637d2fa563d9347cce8aa43b4'
}

function makeRequest(url, options, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url)
        const reqOptions = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname,
            method: options.method || 'GET',
            headers: options.headers || {},
            timeout: 30000
        }

        const req = https.request(reqOptions, res => {
            let data = ''
            res.on('data', chunk => (data += chunk))
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data
                })
            })
        })

        req.on('error', reject)
        req.on('timeout', () => {
            req.destroy()
            reject(new Error('Request timeout'))
        })

        if (body) {
            req.write(body)
        }
        req.end()
    })
}

async function runTests() {
    console.log('Testing proxy:', proxy.name)
    console.log('Base URL:', proxy.baseUrl)
    console.log('Time:', new Date().toISOString())
    console.log('\n')

    // Test 1: 获取模型列表
    console.log('='.repeat(60))
    console.log('[Test 1] GET /v1/models')
    try {
        const result = await makeRequest(`${proxy.baseUrl}/v1/models`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${proxy.apiKey}`
            }
        })
        console.log('Status:', result.status)
        console.log('Response:', result.body.substring(0, 500))
    } catch (e) {
        console.log('Error:', e.message)
    }

    // Test 2: OpenAI格式 - 简单请求
    console.log('\n' + '='.repeat(60))
    console.log('[Test 2] POST /v1/chat/completions (OpenAI格式)')
    const openaiBody = JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'say hi' }],
        max_tokens: 50
    })
    console.log('Request:', openaiBody)
    try {
        const result = await makeRequest(
            `${proxy.baseUrl}/v1/chat/completions`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${proxy.apiKey}`,
                    'Content-Type': 'application/json'
                }
            },
            openaiBody
        )
        console.log('Status:', result.status)
        console.log('Response:', result.body.substring(0, 500))
    } catch (e) {
        console.log('Error:', e.message)
    }

    // Test 3: Claude格式 - /v1/messages
    console.log('\n' + '='.repeat(60))
    console.log('[Test 3] POST /v1/messages (Claude格式)')
    const claudeBody = JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'say hi' }],
        max_tokens: 50
    })
    console.log('Request:', claudeBody)
    try {
        const result = await makeRequest(
            `${proxy.baseUrl}/v1/messages`,
            {
                method: 'POST',
                headers: {
                    'x-api-key': proxy.apiKey,
                    'anthropic-version': '2023-06-01',
                    'Content-Type': 'application/json'
                }
            },
            claudeBody
        )
        console.log('Status:', result.status)
        console.log('Response:', result.body.substring(0, 500))
    } catch (e) {
        console.log('Error:', e.message)
    }

    // Test 4: 使用 x-api-key 而不是 Authorization
    console.log('\n' + '='.repeat(60))
    console.log('[Test 4] POST /v1/chat/completions with x-api-key header')
    try {
        const result = await makeRequest(
            `${proxy.baseUrl}/v1/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'x-api-key': proxy.apiKey,
                    'Content-Type': 'application/json'
                }
            },
            openaiBody
        )
        console.log('Status:', result.status)
        console.log('Response:', result.body.substring(0, 500))
    } catch (e) {
        console.log('Error:', e.message)
    }

    // Test 5: 模拟网页测试发送的请求（流式）
    console.log('\n' + '='.repeat(60))
    console.log('[Test 5] 模拟网页测试 (stream: true)')
    const webBody = JSON.stringify({
        model: 'tinyy-model',
        messages: [{ role: 'user', content: 'say hi' }],
        stream: true
    })
    console.log('Request:', webBody)
    try {
        const result = await makeRequest(
            `${proxy.baseUrl}/v1/chat/completions`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${proxy.apiKey}`,
                    'Content-Type': 'application/json'
                }
            },
            webBody
        )
        console.log('Status:', result.status)
        console.log('Response:', result.body.substring(0, 500))
    } catch (e) {
        console.log('Error:', e.message)
    }

    // Test 6: 测试空body
    console.log('\n' + '='.repeat(60))
    console.log('[Test 6] POST with empty body')
    try {
        const result = await makeRequest(
            `${proxy.baseUrl}/v1/chat/completions`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${proxy.apiKey}`,
                    'Content-Type': 'application/json'
                }
            },
            ''
        )
        console.log('Status:', result.status)
        console.log('Response:', result.body)
    } catch (e) {
        console.log('Error:', e.message)
    }

    // Test 7: 测试无效JSON
    console.log('\n' + '='.repeat(60))
    console.log('[Test 7] POST with invalid JSON')
    try {
        const result = await makeRequest(
            `${proxy.baseUrl}/v1/chat/completions`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${proxy.apiKey}`,
                    'Content-Type': 'application/json'
                }
            },
            '{invalid json}'
        )
        console.log('Status:', result.status)
        console.log('Response:', result.body)
    } catch (e) {
        console.log('Error:', e.message)
    }

    // Test 8: 测试不同的 Content-Type
    console.log('\n' + '='.repeat(60))
    console.log('[Test 8] POST without Content-Type header')
    try {
        const result = await makeRequest(
            `${proxy.baseUrl}/v1/chat/completions`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${proxy.apiKey}`
                }
            },
            openaiBody
        )
        console.log('Status:', result.status)
        console.log('Response:', result.body)
    } catch (e) {
        console.log('Error:', e.message)
    }
}

runTests().catch(console.error)
