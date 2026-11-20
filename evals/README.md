# Nuonuo Prompt & 行为回归评测（`pnpm eval`）

独立的回归评测目录，**不进入默认 `pnpm test` 和 CI**，避免无意消耗真实模型 token。

## 1. 离线回归模式（默认，0 token）

校验 18 个典型场景背后的确定性护栏（话量分档、结束词微回复、结构化/任务汇报单泡保护、AI 腔与禁词清洗、凭据硬拦截、外部输入与高情绪吐槽记忆 `pending` 隔离）：

```sh
pnpm eval
```

## 2. 真实模型实测模式（消耗模型 API）

当你改动了 `packages/core/src/prompts.ts`、`packages/core/src/voice.ts` 或设置/路由策略后，可开启实测模式驱动真实 Router + Voice 链路：

```sh
# 复用环境变量中已配置的 *_API_KEY（如 OPENAI_API_KEY / ANTHROPIC_API_KEY / DEEPSEEK_API_KEY）
NUONUO_EVAL_LIVE=1 pnpm eval

# 如需指定模型 ID：
NUONUO_EVAL_LIVE=1 NUONUO_EVAL_MODEL=deepseek-chat pnpm eval
```
