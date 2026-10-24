import { PresetError } from './core.mjs';

const STAGES = new Set(['rp-last-step.migrate', 'rp-last-step.assemble', 'rp-last-step.render']);
const own = (object, key) => Object.hasOwn(object, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new PresetError('INVALID_MODEL_CONFIG', 'A valid provider, model and model controls are required'); };

export function resolveModelConfig(base = {}, override = {}) {
  if (!record(base) || !record(override)) invalid();
  const provider = override.provider ?? base.provider;
  const model = override.model ?? base.model;
  if (typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim()) invalid();
  const changed = provider !== base.provider || model !== base.model;
  const reasoningEffort = own(override, 'reasoningEffort') ? override.reasoningEffort : changed ? undefined : base.reasoningEffort;
  const maxTokens = own(override, 'maxTokens') ? override.maxTokens : base.maxTokens;
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !reasoningEffort.trim())) invalid();
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) invalid();
  return Object.freeze({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(maxTokens === undefined ? {} : { maxTokens }) });
}

function modelError(code = 'MODEL_CALL_FAILED') {
  return new PresetError(code, 'The selected presentation model could not finish this stage', 502);
}

function tokenUsage(input) {
  const result = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (typeof input?.[key] === 'number' && Number.isFinite(input[key]) && input[key] >= 0) result[key] = input[key];
  }
  return Object.freeze(result);
}

/** Public LLM boundary: no session history, tools, provider errors or reasoning cross it. */
export function createModelCaller(ctx) {
  if (typeof ctx?.llm?.prepareCall !== 'function') throw new TypeError('ctx.llm.prepareCall is required');
  return async function callModel({ sessionId, stageId, config, system, input, signal, onText }) {
    if (!STAGES.has(stageId) || typeof sessionId !== 'string' || !sessionId.trim() || typeof system !== 'string') {
      throw new PresetError('INVALID_MODEL_CALL', 'A session, presentation stage and system instruction are required');
    }
    signal?.throwIfAborted();
    const selected = resolveModelConfig(config);
    let actual = selected;
    let usage = Object.freeze({});
    let finish;
    let text = '';
    const blocks = new Map();
    const blockTypes = new Map();
    async function append(value) {
      if (!value) return;
      text += value;
      await onText?.(value);
      signal?.throwIfAborted();
    }
    try {
      const prepared = await ctx.llm.prepareCall(selected, signal);
      signal?.throwIfAborted();
      actual = resolveModelConfig(prepared.config);
      if (actual.provider !== selected.provider || actual.model !== selected.model) throw modelError('MODEL_ROUTE_CHANGED');
      const stream = prepared.stream({ ...actual, system, messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }], signal });
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        if (finish) throw modelError('MODEL_STREAM_INVALID');
        if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call') || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')) {
          throw modelError('MODEL_TOOL_CALL_REJECTED');
        }
        const type = chunk.type === 'block-start' ? chunk.blockType : chunk.type === 'text-delta' ? 'text' : chunk.type === 'reasoning-delta' ? 'reasoning' : chunk.type === 'block-end' ? chunk.block?.type : undefined;
        if (type !== undefined) {
          if (blockTypes.has(chunk.index) && blockTypes.get(chunk.index) !== type) throw modelError('MODEL_STREAM_INVALID');
          blockTypes.set(chunk.index, type);
        }
        if (chunk.type === 'text-delta') {
          const block = blocks.get(chunk.index) ?? { text: '', closed: false };
          if (block.closed) continue;
          if (typeof chunk.text !== 'string') throw modelError('MODEL_STREAM_INVALID');
          block.text += chunk.text;
          blocks.set(chunk.index, block);
          await append(chunk.text);
        } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
          const block = blocks.get(chunk.index) ?? { text: '', closed: false };
          if (block.closed) continue;
          if (typeof chunk.block.text !== 'string' || !chunk.block.text.startsWith(block.text)) throw modelError('MODEL_STREAM_INVALID');
          await append(chunk.block.text.slice(block.text.length));
          blocks.set(chunk.index, { text: chunk.block.text, closed: true });
        } else if (chunk.type === 'usage') {
          usage = tokenUsage(chunk.usage);
        } else if (chunk.type === 'finish') {
          const kind = chunk.reason?.kind;
          if (kind === 'aborted') throw new DOMException('Presentation cancelled', 'AbortError');
          if (kind !== 'stop' && kind !== 'max-tokens') throw modelError(kind === 'tool-calls' ? 'MODEL_TOOL_CALL_REJECTED' : 'MODEL_CALL_FAILED');
          finish = Object.freeze({ kind });
        }
      }
      signal?.throwIfAborted();
      if (!finish) throw modelError('MODEL_STREAM_INCOMPLETE');
      return { text, usage, finish, config: actual };
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      if (error?.name === 'AbortError') throw error;
      if (error instanceof PresetError) throw error;
      throw modelError();
    }
  };
}
