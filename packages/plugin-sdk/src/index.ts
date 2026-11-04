/**
 * The Super-agent plugin SDK. A plugin contributes Sources: event streams the agent listens to, with a channel to reply
 * on, plus tools, prompt text and environment for the agents. See docs/04-plugin-sdk.md.
 *
 * Plugins installed in <home>/plugins receive the same helpers at runtime as the factory's argument (`sdk`), so they need no
 * dependencies; this package exists for type checking and for first-party plugins in this repository.
 */
export { definePlugin, PLUGIN_API_VERSION, sdk } from '@super-agent/sources'
export type { FieldSpec, Health, OutgoingMessage, PluginSdk, SourceContext, SourceKind, SuperAgentPlugin } from '@super-agent/sources'
export type { IncomingTrigger, Ticket } from '@super-agent/core'
export { jsonSchema, tool } from 'ai'
export { z } from 'zod'
