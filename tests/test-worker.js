const https = require('https');

// 你的 Worker 地址
const workerUrl = 'https://claude-worker-proxy.cncursor.workers.dev';

function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 30000
    };
    
    const req = https.request(reqOptions, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function runTests() {
  console.log('Testing Worker:', workerUrl);
  console.log('Time:', new Date().toISOString());
  console.log('\n');

  // Test 1: 获取模型列表
  console.log('='.repeat(60));
  console.log('[Test 1] GET /v1/models');
  try {
    const result = await makeRequest(`${workerUrl}/v1/models`, {
      method: 'GET'
    });
    console.log('Status:', result.status);
    console.log('Response:', result.body.substring(0, 500));
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Test 2: 模拟网页测试（和网页测试相同的格式）
  console.log('\n' + '='.repeat(60));
  console.log('[Test 2] 模拟网页测试请求');
  const webBody = JSON.stringify({
    model: 'tinyy-model',
    messages: [{ role: 'user', content: 'say hi' }],
    stream: true
  });
  console.log('Request body:', webBody);
  try {
    const result = await makeRequest(`${workerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, webBody);
    console.log('Status:', result.status);
    console.log('Response:', result.body.substring(0, 1000));
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Test 3: 模拟 Cursor 请求（带更多字段）
  console.log('\n' + '='.repeat(60));
  console.log('[Test 3] 模拟 Cursor 请求 (带额外字段)');
  const cursorBody = JSON.stringify({
    model: 'tinyy-model',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'say hello' }
    ],
    stream: true,
    temperature: 0.7,
    max_tokens: 4096
  });
  console.log('Request body:', cursorBody);
  try {
    const result = await makeRequest(`${workerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'User-Agent': 'Cursor/0.45.0'
      }
    }, cursorBody);
    console.log('Status:', result.status);
    console.log('Response:', result.body.substring(0, 1000));
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Test 4: Cursor 带工具调用
  console.log('\n' + '='.repeat(60));
  console.log('[Test 4] 模拟 Cursor 请求 (带 tools)');
  const cursorToolsBody = JSON.stringify({
    model: 'tinyy-model',
    messages: [{ role: 'user', content: 'test' }],
    stream: true,
    tools: [
      {
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'A test tool',
          parameters: {
            type: 'object',
            properties: {
              param1: { type: 'string', description: 'Parameter 1' }
            },
            required: ['param1']
          }
        }
      }
    ]
  });
  console.log('Request body (truncated):', cursorToolsBody.substring(0, 300) + '...');
  try {
    const result = await makeRequest(`${workerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, cursorToolsBody);
    console.log('Status:', result.status);
    console.log('Response:', result.body.substring(0, 1000));
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Test 5: 测试空 body
  console.log('\n' + '='.repeat(60));
  console.log('[Test 5] POST with empty body');
  try {
    const result = await makeRequest(`${workerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, '');
    console.log('Status:', result.status);
    console.log('Response:', result.body);
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Test 6: 测试无效 JSON
  console.log('\n' + '='.repeat(60));
  console.log('[Test 6] POST with invalid JSON');
  try {
    const result = await makeRequest(`${workerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, '{invalid}');
    console.log('Status:', result.status);
    console.log('Response:', result.body);
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Test 7: 查看日志
  console.log('\n' + '='.repeat(60));
  console.log('[Test 7] 获取最近的请求日志');
  try {
    const result = await makeRequest(`${workerUrl}/api/logs`, {
      method: 'GET'
    });
    console.log('Status:', result.status);
    const logs = JSON.parse(result.body);
    console.log('Recent logs:', JSON.stringify(logs.logs, null, 2).substring(0, 2000));
    console.log('\nLast request:', logs.lastRequest ? logs.lastRequest.substring(0, 500) : 'N/A');
    console.log('\nLast response:', logs.lastResponse ? logs.lastResponse.substring(0, 500) : 'N/A');
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Test 8: 获取当前代理配置
  console.log('\n' + '='.repeat(60));
  console.log('[Test 8] 获取当前代理配置');
  try {
    const result = await makeRequest(`${workerUrl}/api/proxy-config`, {
      method: 'GET'
    });
    console.log('Status:', result.status);
    console.log('Response:', result.body);
  } catch (e) {
    console.log('Error:', e.message);
  }
}

runTests().catch(console.error);
