export * from './dingtalk'
export * from './discord'
export * from './feishu'
export * from './gmail'
export * from './slack'
export * from './telegram'
export * from './wecom'

import { dingtalkPlugin } from './dingtalk'
import { discordPlugin } from './discord'
import { feishuPlugin } from './feishu'
import { gmailPlugin } from './gmail'
import { slackPlugin } from './slack'
import { telegramPlugin } from './telegram'
import { wecomPlugin } from './wecom'

/** The plugins that ship with nuonuo, in the order the settings page lists them. Add a new built-in here only. */
export const BUILT_IN_PLUGINS = [telegramPlugin, gmailPlugin, feishuPlugin, discordPlugin, wecomPlugin, dingtalkPlugin, slackPlugin]
