#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createManager } from '../src/manager.mjs';
import { environmentContext, safeError } from '../src/runtime-context.mjs';
import { redactText } from '../src/public-dto.mjs';

const provider = { type: 'string', enum: ['claude', 'codex', 'pi'] };
const text = { type: 'string', minLength: 1, maxLength: 100000 };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const nativeTools = Object.freeze([
  { name: 'paseo_status', description: 'Read managed Paseo readiness and historical verification. Authorization and pairing are handled in the protected setup page.', inputSchema: schema({}), annotations: { readOnlyHint: true } },
  { name: 'paseo_models', description: 'Discover models, modes and thinking levels for an enabled tenant provider.', inputSchema: schema({ provider }, ['provider']), annotations: { readOnlyHint: true } },
  { name: 'paseo_createchat', description: 'Create a coding-agent conversation on the managed tenant daemon, retaining its agent ID for followup. Use catalog modes and existing provider privileges.', inputSchema: schema({ provider, message: text, model: { type: 'string' }, mode: { type: 'string' }, thinking: { type: 'string' }, cwd: { type: 'string' }, title: { type: 'string', maxLength: 200 }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 } }, ['provider', 'message']) },
  { name: 'paseo_continue', description: 'Continue a conversation created by this bridge. Only a new assistant turn counts as a reply.', inputSchema: schema({ agentId: { type: 'string', minLength: 8, maxLength: 100 }, message: text, timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 } }, ['agentId', 'message']) },
]);

export function sanitizeToolResult(value, env = {}) {
  if (typeof value === 'string') return redactText(value, env);
  if (Array.isArray(value)) return value.map(child => sanitizeToolResult(child, env));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:state|env|credentials|authorizationUrl|deviceCode|requiresCode|inputKind|pairingUrl|connectionUri|token|apiKey|password|secret|accessToken|refreshToken)$/i.test(key)) continue;
    if (key === 'url' && (typeof child !== 'string' || !child.startsWith('/') || child.startsWith('//'))) continue;
    result[key] = sanitizeToolResult(child, env);
  }
  return result;
}

export function createNativeMcp(manager, { env = {} } = {}) {
  const server = new Server({ name: 'woow-paseo', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: nativeTools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const input = request.params.arguments || {};
      const tool = nativeTools.find(tool => tool.name === request.params.name);
      if (!tool || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(tool.inputSchema.properties, key)) || tool.inputSchema.required.some(key => input[key] === undefined)) throw { code: 'INVALID_TOOL_INPUT' };
      let result;
      if (tool.name === 'paseo_status') result = await manager.status();
      if (tool.name === 'paseo_models') result = await manager.models(input.provider);
      if (tool.name === 'paseo_createchat') result = await manager.createChat(input);
      if (tool.name === 'paseo_continue') result = await manager.continueChat(input);
      const serialized = JSON.stringify(sanitizeToolResult(result, env));
      return { content: [{ type: 'text', text: serialized }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: safeError(error).code }) }] };
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const context = environmentContext();
    const manager = createManager({ dataDir: context.dataDir, home: context.home, packageRoot: context.packageRoot, env: context.env });
    const server = createNativeMcp(manager, { env: context.env });
    // stdio clients own tool availability, not the managed daemon lifecycle.
    process.once('SIGTERM', () => { manager.cancelPending(); void server.close(); });
    process.once('SIGINT', () => { manager.cancelPending(); void server.close(); });
    await server.connect(new StdioServerTransport());
  } catch { process.exitCode = 1; }
}
