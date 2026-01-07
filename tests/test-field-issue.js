const https = require('https');

const workerUrl = 'https://claude-worker-proxy.cncursor.workers.dev';

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
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: data
        });
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (body) req.write(body);
    req.end();
  });
}

async function testField(name, body) {
  console.log(`Testing: ${name}`);
  console.log(`Body: ${JSON.stringify(body)}`);
  
  try {
    const result = await makeRequest(`${workerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify(body));
    
    const status = result.status === 200 ? '✅ SUCCESS' : '❌ FAILED';
    console.log(`Status: ${result.status} ${status}`);
    if (result.status !== 200) {
      console.log(`Response: ${result.body.substring(0, 300)}`);
    }
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }
  console.log('');
}

async function runTests() {
  console.log('Finding which field causes "invalid JSON body" error...\n');
  console.log('='.repeat(60));
  
  const baseRequest = {
    model: 'tinyy-model',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true
  };
  
  // 基础请求（应该成功）
  await testField('Base request (should work)', baseRequest);
  
  // 测试各个字段
  await testField('With temperature', { ...baseRequest, temperature: 0.7 });
  await testField('With temperature=0', { ...baseRequest, temperature: 0 });
  await testField('With temperature=1', { ...baseRequest, temperature: 1 });
  
  await testField('With max_tokens', { ...baseRequest, max_tokens: 4096 });
  await testField('With max_tokens=100', { ...baseRequest, max_tokens: 100 });
  
  await testField('With system message', {
    model: 'tinyy-model',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' }
    ],
    stream: true
  });
  
  await testField('With top_p', { ...baseRequest, top_p: 0.9 });
  await testField('With presence_penalty', { ...baseRequest, presence_penalty: 0.5 });
  await testField('With frequency_penalty', { ...baseRequest, frequency_penalty: 0.5 });
  
  // 组合测试
  await testField('temperature + max_tokens', { ...baseRequest, temperature: 0.7, max_tokens: 4096 });
  await testField('system + temperature', {
    model: 'tinyy-model',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' }
    ],
    stream: true,
    temperature: 0.7
  });
  
  // 测试 stream: false
  await testField('stream: false', { ...baseRequest, stream: false });
  await testField('stream: false + temperature', { ...baseRequest, stream: false, temperature: 0.7 });
}

runTests().catch(console.error);
