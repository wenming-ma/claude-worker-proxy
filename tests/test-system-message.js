const https = require('https');

// 直接测试上游代理
const proxy = {
  baseUrl: 'https://as086nwvpbrnivunc.imds.ai/api',
  apiKey: 'cr_792fe201363ff3d74cd3e817204c40dda90b1ac637d2fa563d9347cce8aa43b4'
};

function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: options.method || 'POST',
      headers: options.headers || {},
      timeout: 30000
    };
    
    const req = https.request(reqOptions, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function testClaudeFormat(name, body) {
  console.log(`\nTesting: ${name}`);
  console.log(`Body: ${JSON.stringify(body, null, 2)}`);
  
  try {
    const result = await makeRequest(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': proxy.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    }, JSON.stringify(body));
    
    console.log(`Status: ${result.status} ${result.status === 200 ? '✅' : '❌'}`);
    console.log(`Response: ${result.body.substring(0, 500)}`);
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }
}

async function runTests() {
  console.log('Testing Claude API format directly on upstream proxy...');
  console.log('Proxy:', proxy.baseUrl);
  console.log('='.repeat(60));
  
  // Test 1: 基础请求（无 system）
  await testClaudeFormat('No system field', {
    model: 'claude-sonnet-4-5-20250929',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 50
  });
  
  // Test 2: 带 system 字段（顶级字符串）
  await testClaudeFormat('With system as string', {
    model: 'claude-sonnet-4-5-20250929',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 50
  });
  
  // Test 3: 带 system 字段（数组格式）
  await testClaudeFormat('With system as array', {
    model: 'claude-sonnet-4-5-20250929',
    system: [{ type: 'text', text: 'You are helpful.' }],
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 50
  });
  
  // Test 4: 不带 system，带 stream
  await testClaudeFormat('Stream without system', {
    model: 'claude-sonnet-4-5-20250929',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 50,
    stream: true
  });
  
  // Test 5: 带 system 和 stream
  await testClaudeFormat('Stream with system string', {
    model: 'claude-sonnet-4-5-20250929',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 50,
    stream: true
  });
  
  // Test 6: 空 system 字符串
  await testClaudeFormat('Empty system string', {
    model: 'claude-sonnet-4-5-20250929',
    system: '',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 50
  });
  
  // Test 7: 只有空格的 system
  await testClaudeFormat('Whitespace-only system', {
    model: 'claude-sonnet-4-5-20250929',
    system: '   ',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 50
  });
}

runTests().catch(console.error);
