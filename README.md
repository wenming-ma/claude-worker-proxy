把各家（Gemini，OpenAI）的模型 API 转换成 Claude 格式提供服务

**🆕 现在也支持反向代理：将 OpenAI 格式转换为 Claude API，让 Cursor 等工具低成本使用 Claude！**

## 特性

- 🚀 一键部署到 Cloudflare Workers
- 🔄 兼容 Claude Code。配合 [One-Balance](https://github.com/glidea/one-balance) 低成本，0 费用使用 Claude Code
- 🔄 **支持反向代理**：OpenAI 格式 → Claude API（适用于 Cursor、Continue 等工具）
- 📡 支持流式和非流式响应
- 🛠️ 支持工具调用
- 🎯 零配置，开箱即用

## 快速部署

```bash
git clone https://github.com/glidea/claude-worker-proxy
cd claude-worker-proxy
npm install
wrangler login # 如果尚未安装：npm i -g wrangler@latest

# 设置 Claude API Key（用于反向代理功能）
wrangler secret put CLAUDE_API_KEY

npm run deploycf
```

## 使用方法

### 方式一：OpenAI 格式调用 Claude API（反向代理）

**适用于：Cursor、Continue、其他仅支持 OpenAI 格式的工具**

```bash
curl -X POST https://claude-worker-proxy.xxxx.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

#### 在 Cursor 中使用

1. 打开 Cursor 设置
2. 找到 "Models" → "OpenAI API Key" 配置
3. 设置自定义 Base URL：`https://claude-worker-proxy.xxxx.workers.dev`
4. API Key 留空（不需要）
5. 模型选择：使用以下任一模型名
    - `tinyy-model` → 自动映射到 claude-sonnet-4-5-20250929 (Sonnet 4.5 - 快速且高性价比)
    - `bigger-model` → 自动映射到 claude-opus-4-5-20251101 (Opus 4.5 - 最强大)
    - `gpt-4` → 自动映射到 claude-opus-4-5-20251101
    - `gpt-4o` → 自动映射到 claude-sonnet-4-5-20250929
    - 或直接使用官方 Claude 模型名

**模型名称映射**：为了方便使用，代理支持自定义模型名称映射。你可以在 Cursor 中配置简短的模型名（如 `tinyy-model`），代理会自动转换为对应的 Claude 模型。映射表位于 `src/claude.ts`。

#### 环境变量配置

在 `wrangler.jsonc` 中配置（或使用 `wrangler secret put`）：

```jsonc
{
    "vars": {
        "CLAUDE_API_KEY": "your-claude-api-key",
        "CLAUDE_BASE_URL": "https://api.anthropic.com" // 可选，默认值
        // 或使用第三方 Claude 代理：
        // "CLAUDE_BASE_URL": "https://as086nwvpbrnivunc.imds.ai/api"
    }
}
```

**已验证的配置**：

- 官方 API：`https://api.anthropic.com`（需要官方 API Key）
- 第三方代理：`https://as086nwvpbrnivunc.imds.ai/api`（已测试可用）

---

### 方式二：Claude 格式调用其他模型（原有功能）

**适用于：Claude Code 等工具**

```bash
# 例子：以 Claude 格式请求 Gemini 后端
curl -X POST https://claude-worker-proxy.xxxx.workers.dev/gemini/https://generativelanguage.googleapis.com/v1beta/v1/messages \
  -H "x-api-key: YOUR_GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

### 参数说明

**方式一（OpenAI → Claude）：**

- URL：`{worker_url}/v1/chat/completions`
- 请求格式：OpenAI chat completions API 格式
- 无需 API Key header（API Key 在环境变量中配置）

**方式二（Claude → Provider）：**

- URL 格式：`{worker_url}/{type}/{provider_url_with_version}/v1/messages`
- `type`: 目标厂商类型，目前支持 `gemini`, `openai`
- `provider_url_with_version`: 目标厂商 API 基础地址
- `x-api-key`: 目标厂商的 API Key

### 在 Claude Code 中使用

```bash
# 编辑 ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://claude-worker-proxy.xxxx.workers.dev/gemini/https://xxx.com/v1beta", # https://xxx.com/v1beta： 注意带版本号；需要支持函数调用！
    "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: YOUR_KEY",
    "ANTHROPIC_MODEL": "gemini-2.5-pro", # 大模型，按需修改
    "ANTHROPIC_SMALL_FAST_MODEL": "gemini-2.5-flash", # 小模型。也许你并不需要 ccr 那么强大的 route
    "API_TIMEOUT_MS": "600000"
  }
}

claude
```

---

<table>
  <tr>
    <td align="center">
      <img src="https://github.com/glidea/zenfeed/blob/main/docs/images/wechat.png?raw=true" alt="Wechat QR Code" width="300">
      <br>
      <strong>AI 学习交流社群</strong>
    </td>
    <td align="center">
      <img src="https://github.com/glidea/banana-prompt-quicker/blob/main/images/glidea.png?raw=true" width="250">
      <br>
      <strong><a href="https://glidea.zenfeed.xyz/">我的其它项目</a></strong>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="2">
      <img src="https://github.com/glidea/banana-prompt-quicker/blob/main/images/readnote.png?raw=true" width="400">
      <br>
      <strong><a href="https://www.xiaohongshu.com/user/profile/5f7dc54d0000000001004afb">📕 小红书账号 - 持续分享 AI 原创</a></strong>
    </td>
  </tr>
</table>
