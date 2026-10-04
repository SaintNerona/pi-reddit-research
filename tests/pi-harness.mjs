import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

export const piDist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const { loadExtensions } = await import(pathToFileURL(join(piDist, 'core/extensions/loader.js')));
const { wrapRegisteredTool } = await import(pathToFileURL(join(piDist, 'core/extensions/wrapper.js')));

export async function loadTools(extensionPath = join(process.cwd(), 'extensions/reddit-research.ts')) {
  const loaded = await loadExtensions([extensionPath], process.cwd());
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  if (loaded.extensions.length !== 1) throw new Error('Expected one loaded extension');
  return loaded.extensions[0];
}

// The model stream is synthetic; registration, preparation, validation and execution are real Pi.
export async function invoke(extension, name, args) {
  let turn = 0;
  const agent = new Agent({
    initialState: {
      model: { id: 'test-model', name: 'Synthetic model', api: 'openai-completions', provider: 'test', baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 },
      tools: [...extension.tools.values()].map((registered) =>
        wrapRegisteredTool(registered, { createToolContext: () => ({}) })),
    },
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const call = turn++ === 0;
      const message = {
        role: 'assistant', api: 'openai-completions', provider: 'openai', model: 'gpt-4o',
        content: call ? [{ type: 'toolCall', id: 'test-call', name, arguments: args }] : [{ type: 'text', text: 'done' }],
        stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end(message);
      return stream;
    },
  });
  await agent.prompt('Execute the test tool call.');
  const result = agent.state.messages.find((message) => message.role === 'toolResult');
  if (!result) throw new Error('Pi did not produce a tool result');
  return result;
}
