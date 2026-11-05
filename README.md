# kfc2api

OpenAI Chat Completions / Responses 兼容的假模型，可部署到 Cloudflare Workers。

## 开发

```bash
npm install
npm run dev
```

## 部署

```bash
cp wrangler.example.jsonc wrangler.jsonc
# 修改 wrangler.jsonc 的配置
npx wrangler deploy
```
