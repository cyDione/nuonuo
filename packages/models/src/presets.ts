/**
 * Recommended layer setups for a provider, applied on first start when the layers are empty, or from Settings → Models.
 * DeepSeek (2026-11): `deepseek-flash` serves V4.1 Flash, `deepseek-v4-pro` V4 Pro; prices are the peak rates in USD per 1M tokens.
 */
import type { ProviderKind } from './catalog'
import type { ProviderOptions } from './factory'
import type { RoleConfig, RoleId } from './roles'

export interface LayerPreset {
  id: string
  label: string
  kind: ProviderKind
  /** Layer → model id and settings; `providerId` is filled in when applied. */
  layers: Partial<Record<RoleId, { model: string } & Omit<RoleConfig, 'chain' | 'enabled'> & { enabled?: boolean }>>
  prices?: NonNullable<ProviderOptions['prices']>
}

export const LAYER_PRESETS: readonly LayerPreset[] = [{
  id: 'deepseek',
  label: 'DeepSeek 推荐配置',
  kind: 'deepseek',
  layers: {
    // Every conversation-facing layer uses V4.1 Flash with high reasoning, as the owner asked.
    router: { model: 'deepseek-flash', reasoning: 'high' },
    // Task execution: the stronger V4 Pro; subagents inherit it.
    worker: { model: 'deepseek-v4-pro', reasoning: 'high' },
    reviewer: { model: 'deepseek-v4-pro', reasoning: 'high' },
    watchdog: { model: 'deepseek-flash', reasoning: 'high' },
    summarizer: { model: 'deepseek-flash', reasoning: 'low' },
    vision: { model: 'deepseek-flash', reasoning: 'high' },
    filter: { model: 'deepseek-flash', reasoning: 'low', enabled: false },
  },
  prices: {
    'deepseek-flash': { input: 0.3, cacheRead: 0.006, output: 1.2 },
    'deepseek-v4-pro': { input: 1.32, cacheRead: 0.044, output: 3.96 },
  },
}]
