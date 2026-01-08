const https = require('https')

// 测试 crs.itssx.com 代理是否支持 system 字段
const proxy = {
    baseUrl: 'https://crs.itssx.com/api',
    apiKey: 'cr_f7907136f46a1fc63156cec6698644b3e9db7792ff79aaf307925847eedec7bd'
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
        if (body) req.write(body)
        req.end()
    })
}

async function testClaudeFormat(name, body) {
    console.log(`\nTesting: ${name}`)
    console.log(`Body: ${JSON.stringify(body, null, 2)}`)

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
    console.log('Testing crs.itssx.com proxy for system field support...')
    console.log('Proxy:', proxy.baseUrl)
    console.log('='.repeat(60))

    // Test 1: 无 system
    await testClaudeFormat('No system field', {
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 50
    })

    // Test 2: 带 system 字符串
    await testClaudeFormat('With system string', {
        model: 'claude-sonnet-4-5-20250929',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 50
    })

    // Test 3: 带 stream
    await testClaudeFormat('Stream without system', {
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 50,
        stream: true
    })

    // Test 4: 带 system 和 stream
    await testClaudeFormat('Stream with system', {
        model: 'claude-sonnet-4-5-20250929',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 50,
        stream: true
    })
}

runTests().catch(console.error)
