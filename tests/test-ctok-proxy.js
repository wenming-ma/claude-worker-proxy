const https = require('https')

const proxy = {
    baseUrl: 'https://as1.ctok.ai/api',
    apiKey: 'cr_792fe201363ff3d74cd3e817204c40dda90b1ac637d2fa563d9347cce8aa43b4'
}

function makeRequest(url, options, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url)
        const reqOptions = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname,
            method: options.method || 'POST',
            headers: options.headers || {},
            timeout: 30000
        }

        const req = https.request(reqOptions, res => {
            let data = ''
            res.on('data', chunk => (data += chunk))
            res.on('end', () => resolve({ status: res.statusCode, body: data }))
        })

        req.on('error', reject)
        req.on('timeout', () => {
            req.destroy()
            reject(new Error('Request timeout'))
        })

        if (body) req.write(body)
        req.end()
    })
}

async function testClaudeFormat(name, body) {
    console.log(`\nTesting: ${name}`)
    console.log(`Body: ${JSON.stringify(body)}`)

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
            JSON.stringify(body)
        )

        console.log(`Status: ${result.status} ${result.status === 200 ? '✅' : '❌'}`)
        console.log(`Response: ${result.body.substring(0, 300)}`)
    } catch (e) {
        console.log(`Error: ${e.message}`)
    }
}

async function runTests() {
    console.log('Testing proxy: as1.ctok.ai')
    console.log('='.repeat(60))

    // Test 1: 获取模型列表
    console.log('\n[Test 1] GET /v1/models')
    try {
        const result = await makeRequest(`${proxy.baseUrl}/v1/models`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${proxy.apiKey}` }
        })
        console.log(`Status: ${result.status}`)
        console.log(`Response: ${result.body.substring(0, 300)}`)
    } catch (e) {
        console.log(`Error: ${e.message}`)
    }

    // Test 2: 基础请求（无 system，无 temperature）
    await testClaudeFormat('No system, no temperature', {
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'say hi' }],
        max_tokens: 50
    })

    // Test 3: 带 system
    await testClaudeFormat('With system string', {
        model: 'claude-sonnet-4-5-20250929',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'say hi' }],
        max_tokens: 50
    })

    // Test 4: 带 temperature=0
    await testClaudeFormat('With temperature=0', {
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'say hi' }],
        max_tokens: 50,
        temperature: 0
    })

    // Test 5: 带 temperature=0.7
    await testClaudeFormat('With temperature=0.7', {
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'say hi' }],
        max_tokens: 50,
        temperature: 0.7
    })

    // Test 6: 带 system + temperature
    await testClaudeFormat('With system + temperature', {
        model: 'claude-sonnet-4-5-20250929',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'say hi' }],
        max_tokens: 50,
        temperature: 0.5
    })

    // Test 7: 带 stream
    await testClaudeFormat('With stream=true', {
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'say hi' }],
        max_tokens: 50,
        stream: true
    })

    // Test 8: 完整测试（system + temperature + stream）
    await testClaudeFormat('Full test: system + temperature + stream', {
        model: 'claude-sonnet-4-5-20250929',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'say hi' }],
        max_tokens: 50,
        temperature: 0.7,
        stream: true
    })
}

runTests().catch(console.error)
