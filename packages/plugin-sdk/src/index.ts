/**
 * The Nuonuo plugin SDK. A plugin contributes Sources: event streams the agent listens to, with a channel to reply
 * on, plus tools, prompt text and environment for the agents. Chat apps are written with `defineChannel`, which adds
 * everything chat apps share (docs/12-channels.md). See docs/04-plugin-sdk.md.
 *
 * Plugins installed in <home>/plugins receive the same helpers at runtime as the factory's argument (`sdk`), so they need no
 * dependencies; this package exists for type checking and for first-party plugins in this repository.
 */
export { appToken, ChannelError, channelThread, oauth, defineChannel, definePlugin, parseChannelThread, plainText, PLUGIN_API_VERSION, sdk, splitText } from '@nuonuo/sources'
export type { AppToken, CodeFlow, DeviceFlow, OAuth } from '@nuonuo/sources'
export type { ChannelAction, ChannelCapabilities, ChannelIO, ChannelMessage, ChannelOut, ChannelSpec, ChannelTarget, ChannelUser, SocketHandlers, SocketLike, DeviceCode, FieldSpec, Health, OutgoingMessage, PluginMcpServer, PluginSdk, SourceAction, SourceContext, SourceKind, NuonuoPlugin } from '@nuonuo/sources'
export type { IncomingTrigger, Ticket } from '@nuonuo/core'
export { jsonSchema, tool } from 'ai'
export { z } from 'zod'
