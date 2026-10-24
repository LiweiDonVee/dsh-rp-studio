import { createHash } from 'node:crypto';
import { PresetError, applyAgentOperations, compileProfile, emptyOverlay, validateProfile } from './core.mjs';
import { resolveModelConfig } from './models.mjs';
import { publicReceipt } from './receipts.mjs';

const has = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const THOUGHT = /^(think|thinking|analysis|reasoning)$/iu;
const STAGES = { migrate: 'rp-last-step.migrate', assemble: 'rp-last-step.assemble', render: 'rp-last-step.render' };
const DONE = new Set(['rendered', 'complete']);

function fail(code, message, status = 400) { throw new PresetError(code, message, status); }
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const snapshot = (value) => freeze(structuredClone(value));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_REQUEST', `${label} must be a nonempty string`);
  return value;
}
function keys(value, allowed, code) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(code, 'Unexpected fields in stage response');
}

export function normalizeDirectionPacket(input) {
  const allowed = ['playerAction', 'sceneInstruction', 'resolvedChanges', 'visibleConsequences', 'openHooks', 'proseConstraints', 'publicFactRefs', 'variables'];
  keys(input, allowed, 'INVALID_DIRECTION_PACKET');
  if (typeof input.playerAction !== 'string' || !input.playerAction.trim()) fail('INVALID_DIRECTION_PACKET', 'playerAction must be a nonempty public string');
  const output = { playerAction: input.playerAction };
  if (has(input, 'sceneInstruction')) {
    if (typeof input.sceneInstruction !== 'string') fail('INVALID_DIRECTION_PACKET', 'sceneInstruction must be public text');
    output.sceneInstruction = input.sceneInstruction;
  }
  for (const key of ['resolvedChanges', 'visibleConsequences', 'openHooks', 'proseConstraints', 'publicFactRefs']) {
    if (!has(input, key)) continue;
    if (!Array.isArray(input[key]) || input[key].some((item) => typeof item !== 'string')) fail('INVALID_DIRECTION_PACKET', `${key} must contain public strings`);
    output[key] = [...input[key]];
  }
  if (has(input, 'variables')) {
    if (!record(input.variables) || Object.values(input.variables).some((value) => typeof value !== 'string')) fail('INVALID_DIRECTION_PACKET', 'variables must map names to public strings');
    output.variables = Object.fromEntries(Object.entries(input.variables));
  }
  return snapshot(output);
}

/** Delay tag bytes until their meaning is known, including across stream chunks. */
function thoughtGate(onText) {
  let buffer = '';
  let text = '';
  const stack = [];
  async function emit(value) {
    if (!value || stack.length) return;
    text += value;
    await onText(value);
  }
  function unsafe() { fail('UNSAFE_THOUGHT_STREAM', 'The writer returned malformed or unfinished private reasoning', 502); }
  async function drain(final) {
    while (buffer) {
      const start = buffer.indexOf('<');
      if (start === -1) {
        await emit(buffer);
        buffer = '';
        break;
      }
      await emit(buffer.slice(0, start));
      buffer = buffer.slice(start);
      const end = buffer.indexOf('>');
      const nested = buffer.indexOf('<', 1);
      if (nested !== -1 && (end === -1 || nested < end)) {
        if (/^<\s*\/?\s*(think|thinking|analysis|reasoning)(?:\b|$)/iu.test(buffer.slice(0, nested))) unsafe();
        await emit(buffer.slice(0, nested));
        buffer = buffer.slice(nested);
        continue;
      }
      if (end === -1) {
        if (final) {
          const candidate = buffer.replace(/^<\s*\/?\s*/u, '').toLowerCase();
          if (candidate && ['think', 'thinking', 'analysis', 'reasoning'].some((name) => name.startsWith(candidate) || candidate.startsWith(name))) unsafe();
          await emit(buffer);
          buffer = '';
        }
        break;
      }
      const token = buffer.slice(0, end + 1);
      buffer = buffer.slice(end + 1);
      const parsed = /^<\s*(\/?)\s*([a-z]+)\s*>$/iu.exec(token);
      if (parsed && THOUGHT.test(parsed[2])) {
        const name = parsed[2].toLowerCase();
        if (parsed[1]) {
          if (stack.pop() !== name) unsafe();
        } else stack.push(name);
      } else {
        if (/^<\s*\/?\s*(think|thinking|analysis|reasoning)(?:\b|$)/iu.test(token)) unsafe();
        await emit(token);
      }
    }
    if (final && stack.length) unsafe();
  }
  return {
    async push(value) {
      if (typeof value !== 'string') unsafe();
      buffer += value;
      await drain(false);
    },
    async end() { await drain(true); return text; },
  };
}

// Only a leading model thought/fence is transport syntax. Literal tags inside JSON stay intact.
function stageJson(text) {
  if (typeof text !== 'string') fail('INVALID_STAGE_JSON', 'The stage must return a JSON object');
  let source = text.trim();
  while (true) {
    const opening = /^<(think|thinking|analysis|reasoning)\s*>/iu.exec(source);
    if (!opening) break;
    const closing = new RegExp(`</${opening[1]}\\s*>`, 'iu');
    const rest = source.slice(opening[0].length);
    const end = closing.exec(rest);
    if (!end) fail('INVALID_STAGE_JSON', 'The stage returned unfinished leading reasoning');
    source = rest.slice(end.index + end[0].length).trim();
  }
  if (source.startsWith('```')) {
    const fence = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/iu.exec(source);
    if (!fence) fail('INVALID_STAGE_JSON', 'The stage returned an invalid JSON fence');
    source = fence[1];
  }
  let parsed;
  try { parsed = JSON.parse(source); }
  catch { fail('INVALID_STAGE_JSON', 'The stage must return valid JSON'); }
  if (!record(parsed)) fail('INVALID_STAGE_JSON', 'The stage must return a JSON object');
  return parsed;
}

function effectiveEntries(profile, overlay) {
  return [...profile.entries, ...overlay.additions].map((entry) => {
    const patch = has(overlay.entries, entry.id) ? overlay.entries[entry.id] : {};
    return { ...entry, ...patch, fills: { ...entry.fills, ...patch.fills } };
  }).sort((a, b) => a.order - b.order);
}

function catalog(profile, overlay) {
  return effectiveEntries(profile, overlay).map((entry) => ({
    id: entry.id, name: entry.name, role: entry.role, phase: entry.phase, order: entry.order,
    enabled: entry.enabled, required: entry.required, locked: entry.locked,
    marker: entry.marker === true, contentLength: entry.content.length,
  }));
}

function readableEntry(entry) {
  const output = {};
  for (const key of ['id', 'name', 'content', 'role', 'phase', 'order', 'enabled', 'required', 'locked', 'marker', 'fills']) if (has(entry, key)) output[key] = entry[key];
  if (entry.source) output.source = { entryId: entry.source.entryId, ...(typeof entry.source.format === 'string' ? { format: entry.source.format } : {}) };
  return output;
}

const metadataKey = (key) => key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').replace(/[^A-Za-z0-9]+/gu, '_').toLowerCase();
const CONNECTION_METADATA = /(?:^|_)(?:api_key|password|secret|token|credentials?|authorization|private_key|endpoint|url|uri|host|proxy|headers?)(?:_|$)/u;
const BODY_METADATA = new Set(['content', 'code', 'script', 'source', 'javascript', 'js', 'html', 'css', 'body']);

// Only migration reads this projection. Executable bodies stay inert in immutable source.
function projectSourceMetadata(value, key = '') {
  const normalized = metadataKey(key);
  if (CONNECTION_METADATA.test(normalized)) return undefined;
  if (typeof value === 'string') {
    if (/^(?:https?|wss?):\/\//iu.test(value.trim())) return { omitted: 'connection address' };
    if (BODY_METADATA.has(normalized) || value.length > 8192) return { retainedInSource: true, characters: value.length, sha256: hash(value) };
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => projectSourceMetadata(item)).filter((item) => item !== undefined);
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, projectSourceMetadata(item, name)]).filter(([, item]) => item !== undefined));
  return value;
}

function sourceMetadataProjection(profile, source) {
  let original = {};
  if (source) {
    try { original = JSON.parse(source.rawText.replace(/^\uFEFF/u, '')); }
    catch { fail('SOURCE_METADATA_INVALID', 'The immutable preset source could not be read for migration', 500); }
    if (!record(original)) fail('SOURCE_METADATA_INVALID', 'The immutable preset source must be an object', 500);
  }
  const unsupportedFeatures = [];
  const warning = (code, message, extra = {}) => unsupportedFeatures.push({ code, severity: 'warning', message, ...extra });
  const entries = profile.entries.map((entry) => {
    const provenance = entry.source ?? {};
    const prompt = record(provenance.originalPrompt) ? provenance.originalPrompt
      : Array.isArray(original.prompts) ? original.prompts.find((item, index) => record(item) && (String(item.identifier) === provenance.entryId || index === provenance.index)) ?? {} : {};
    const { content, ...metadata } = prompt;
    const originalPrompt = projectSourceMetadata(metadata);
    if (['injection_depth', 'injection_position', 'injection_order'].some((key) => has(prompt, key))) {
      warning('INJECTION_REQUIRES_ADAPTATION', 'SillyTavern depth/history insertion is unsupported: this runtime compiles static ordered modules. Review the original injection depth, position and order before enabling.', { entryId: entry.id });
    }
    if (prompt.forbid_overrides === true) warning('ST_LOCK_POLICY_REVIEW', 'Original forbid_overrides is provenance, not an automatic owner lock. Preserve the current explicit locked/required policy and report any conflict.', { entryId: entry.id });
    if (prompt.marker === true) warning('MARKER_REQUIRES_MAPPING', 'Original ST markers need explicit public runtime values or adapted content; automatic ST context insertion is unavailable.', { entryId: entry.id });
    return {
      entryId: entry.id, sourceEntryId: provenance.entryId ?? null,
      ...(provenance.index === undefined ? {} : { index: provenance.index }), originalPrompt,
      ...(typeof content === 'string' ? { originalContent: { suppliedByCurrentEntry: content === entry.content, characters: content.length, sha256: hash(content) } } : {}),
      promptOrder: projectSourceMetadata(provenance.promptOrder ?? null), orderCharacterId: provenance.orderCharacterId ?? null,
    };
  });
  const groups = Array.isArray(original.prompt_order) ? original.prompt_order : [];
  const pinnedCharacterId = entries.find((entry) => entry.orderCharacterId !== null)?.orderCharacterId;
  const selected = groups.find((group) => record(group) && String(group.character_id) === String(pinnedCharacterId ?? 100001)) ?? groups[0] ?? null;
  const selectedCharacterId = pinnedCharacterId ?? selected?.character_id ?? null;
  if (groups.length > 1) warning('ORDER_SELECTED', 'Only the selected ST character order is compiled. Other character orders are retained as metadata; automatic character-specific switching is unsupported.');

  const features = [];
  function findFeatures(value, path = []) {
    if (Array.isArray(value)) { value.forEach((item, index) => findFeatures(item, [...path, String(index)])); return; }
    if (!record(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = metadataKey(key);
      const kind = /^regex_scripts?$/u.test(normalized) ? 'regex' : /^(?:tavern_helper|tavern_helper_scripts?|tavernhelper|tavernhelper_scripts?)$/u.test(normalized) ? 'tavern-helper' : null;
      if (kind) features.push({ kind, path: [...path, key].join('.'), ...(Array.isArray(child) ? { count: child.length } : Array.isArray(child?.scripts) ? { count: child.scripts.length } : {}) });
      findFeatures(child, [...path, key]);
    }
  }
  findFeatures(original);
  if (features.some((feature) => feature.kind === 'regex')) warning('REGEX_SCRIPTS_INERT', 'ST regex scripts/settings are retained but never run. Replacements, placement/depth filters and edit-time behavior need explicit supported adaptation; they are not applied to model input or prose.');
  if (features.some((feature) => feature.kind === 'tavern-helper')) warning('TAVERN_HELPER_SCRIPTS_INERT', 'TavernHelper scripts/settings are retained but never executed. JavaScript, browser integrations and state/tool behavior require supported runtime capabilities or remain unresolved.');
  if (has(original, 'extensions')) warning('EXTENSIONS_INERT', 'Original extensions remain inert. Unknown extension behavior is unsupported until explicitly mapped; preserved settings do not establish runtime compatibility.');
  const { prompts: _prompts, prompt_order: _order, extensions, ...settings } = original;
  return snapshot({
    id: source?.id ?? profile.sourceId, format: source?.format ?? null, ...(source?.sha256 ? { sha256: source.sha256 } : {}),
    entries, promptOrder: { selectedCharacterId, selected: projectSourceMetadata(selected), groups: projectSourceMetadata(groups) },
    settings: projectSourceMetadata(settings), ...(extensions === undefined ? {} : { extensions: projectSourceMetadata(extensions) }),
    features, unsupportedFeatures,
    contentPolicy: 'Current entry text is supplied once in profile.entries. Original bodies, script bodies, connection settings and oversized metadata stay in immutable source; metadata never executes.',
  });
}

const ASSEMBLE_SYSTEM = `RP_LAST_STEP_ASSEMBLE
You assemble the user's preset after simulation and tools have finished. Use only the public direction packet. Do not simulate, call tools, write world state or invent outcomes.
You first receive a module catalog, not all module bodies. Read entries on demand. Reply with one JSON object: {"read":["entryId"],"operations":[],"commit":false}. read/operations may be omitted; commit must be boolean.
Operations are enable/disable {op,entryId}, replace {op,entryId,content}, fill {op,entryId,key,value}, add {op,entry:{id,name?,content,role?,order?,enabled?,phase:"render"}}, and remove {op,entryId} for temporary additions only.
User locks are immutable. Required entries stay enabled and nonempty. Never bypass a locked module by adding an override. Phase and source identity are immutable here. Edits affect a session overlay only.
Feedback contains requested effective entries, current catalog and compiler diagnostics. Fix unresolved macros only from public facts, or leave blocked. Commit only a valid final composition. The writer receives render/shared modules only.`;

const RENDER_SYSTEM = `RP_LAST_STEP_RENDER
Write the final narrative from the ordered render/shared preset modules, public direction packet and explicitly public recent prose. Preserve module roles, style and order. The packet contains outcomes already resolved by the agent and tools.
Keep resolved changes and visible consequences authoritative. Do not simulate again, flip results, award items, write state, choose the player's next action or invent their private thoughts. Use proseConstraints and sceneInstruction for the permitted creative space. Missing facts stay undecided.
Return only the narrative. Do not include reasoning, analysis, tool calls, implementation details or private thought tags.`;

function policyError(code, entryId) {
  const error = new PresetError(code, 'Migration conflicts with owner policy', 403);
  if (entryId !== undefined) error.entryId = entryId;
  return error;
}

function migrationCandidate(profile, response) {
  keys(response, ['updates', 'additions', 'report'], 'INVALID_MIGRATION_PATCH');
  if (!Array.isArray(response.updates ?? []) || !Array.isArray(response.additions ?? [])) fail('INVALID_MIGRATION_PATCH', 'Migration updates and additions must be arrays');
  const report = response.report;
  keys(report, ['summary', 'changes', 'blocked', 'diagnostics'], 'INVALID_MIGRATION_PATCH');
  if (typeof report.summary !== 'string' || !report.summary.trim()) fail('INVALID_MIGRATION_PATCH', 'Migration requires a summary');
  for (const key of ['changes', 'blocked', 'diagnostics']) if (has(report, key) && !Array.isArray(report[key])) fail('INVALID_MIGRATION_PATCH', 'Migration report details must be arrays');
  const entries = structuredClone(profile.entries);
  const updates = new Set();
  const editable = ['id', 'name', 'content', 'phase', 'role', 'order', 'enabled', 'marker', 'fills'];
  for (const update of response.updates ?? []) {
    if (!record(update) || typeof update.id !== 'string') fail('INVALID_MIGRATION_PATCH', 'Each update requires an entry id');
    if (Object.keys(update).some((key) => !editable.includes(key))) throw policyError('MIGRATION_PROTECTED_FIELD', update.id);
    const index = entries.findIndex((entry) => entry.id === update.id);
    if (index === -1 || updates.has(update.id)) fail('INVALID_MIGRATION_PATCH', 'Migration update ids must be unique existing entries');
    updates.add(update.id);
    const current = entries[index];
    if (current.locked && Object.keys(update).some((key) => key !== 'id')) throw policyError('ENTRY_LOCKED', current.id);
    if (current.required && update.enabled === false) throw policyError('ENTRY_REQUIRED', current.id);
    if (!current.enabled && update.enabled === true) throw policyError('MIGRATION_DEFAULT_OFF', current.id);
    if (current.required && has(update, 'content') && typeof update.content === 'string' && !update.content.trim()) throw policyError('REQUIRED_EMPTY', current.id);
    entries[index] = { ...current, ...structuredClone(update) };
  }
  const ids = new Set(entries.map((entry) => entry.id));
  for (const addition of response.additions ?? []) {
    keys(addition, [...editable, 'source', 'required', 'locked'], 'INVALID_MIGRATION_PATCH');
    if (addition.required === true || addition.locked === true) throw policyError('MIGRATION_PROTECTED_FIELD', addition.id);
    if (typeof addition.id !== 'string' || !addition.id.trim() || ids.has(addition.id)) fail('INVALID_MIGRATION_PATCH', 'Added entries need unique new ids');
    ids.add(addition.id);
    let source;
    let enabled = addition.enabled ?? true;
    if (has(addition, 'source')) {
      keys(addition.source, ['entryId', 'reason'], 'INVALID_MIGRATION_PATCH');
      const parent = profile.entries.find((entry) => entry.id === addition.source.entryId);
      if (!parent) fail('INVALID_MIGRATION_PATCH', 'Split entries must reference an existing parent');
      if (parent.locked) throw policyError('ENTRY_LOCKED', parent.id);
      if (!parent.enabled) {
        if (addition.enabled === true) throw policyError('MIGRATION_DEFAULT_OFF', parent.id);
        enabled = false;
      }
      source = parent.source ? structuredClone(parent.source) : { entryId: parent.id };
      if (addition.source.reason !== undefined) {
        if (typeof addition.source.reason !== 'string') fail('INVALID_MIGRATION_PATCH', 'Split reason must be text');
        source.splitReason = addition.source.reason;
      }
    }
    entries.push({ ...structuredClone(addition), enabled, required: false, locked: false, ...(source ? { source } : {}) });
  }
  return { profile: validateProfile({ ...profile, status: 'draft', entries }), report: structuredClone(report) };
}

/** Post-simulation presentation only; it owns no world state and never reads main history. */
export function createPresenter({ store, receipts, callModel, resolveModels, publish = () => {}, skillText = '', skillReference = '', maxAssemblySteps = 8, maxMigrationAttempts = 3 } = {}) {
  if (!store || !receipts || typeof callModel !== 'function') throw new TypeError('store, receipts and callModel are required');
  for (const [name, value] of Object.entries({ maxAssemblySteps, maxMigrationAttempts })) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  const active = new Set();

  async function emit(event) { await publish(snapshot(event)); }
  async function modelsFor(sessionId, baseModel) {
    const base = resolveModelConfig(baseModel);
    const selected = await resolveModels?.({ sessionId, baseModel: base }) ?? {};
    return snapshot(Object.fromEntries(Object.keys(STAGES).map((stage) => [stage, resolveModelConfig(base, selected[stage] ?? {})])));
  }
  function actualConfig(selected, actual) {
    if (actual === undefined) return selected;
    const resolved = resolveModelConfig(actual);
    if (resolved.provider !== selected.provider || resolved.model !== selected.model) fail('MODEL_ROUTE_CHANGED', 'The selected stage model changed during dispatch', 502);
    return resolved;
  }
  async function checkCurrent(sessionId, revision, binding) {
    const state = await store.snapshot();
    if (state.revision !== revision) fail('REVISION_CONFLICT', 'The preset changed while this presentation was being assembled', 409);
    const current = has(state.bindings, sessionId) ? state.bindings[sessionId] : null;
    if (!current || current.profileId !== binding.profileId || current.version !== binding.version || hash(current.overlay) !== hash(binding.overlay)) fail('BINDING_CONFLICT', 'The session preset binding changed during presentation', 409);
  }
  async function owned(sessionId, id) {
    const value = await receipts.get(id);
    if (!value || value.sessionId !== sessionId) fail('RECEIPT_NOT_FOUND', 'Presentation record not found', 404);
    return value;
  }
  async function markFailed(receipt, error, sessionId) {
    const cancelled = error?.name === 'AbortError';
    const status = cancelled ? 'cancelled' : 'failed';
    const code = error instanceof PresetError ? error.code : cancelled ? 'PRESENTATION_CANCELLED' : 'PRESENTATION_FAILED';
    const updated = await receipts.update(receipt.id, { status, errorCode: code });
    try { await emit({ sessionId, presentationId: receipt.id, stageId: receipt.stageId ?? STAGES.render, status, code }); } catch { /* Preserve the primary model/store error. */ }
    return publicReceipt(updated);
  }

  return Object.freeze({
    async present({ sessionId, contextKey, packet: input, baseModel, recentProse = [], signal } = {}) {
      nonempty(sessionId, 'Session id');
      nonempty(contextKey, 'Context key');
      const packet = normalizeDirectionPacket(input);
      if (!Array.isArray(recentProse) || recentProse.some((value) => typeof value !== 'string')) fail('INVALID_PUBLIC_PROSE', 'Recent prose must be explicitly public strings');
      const prose = snapshot(recentProse);
      const key = JSON.stringify([sessionId, contextKey]);
      if (active.has(key)) fail('PRESENTATION_BUSY', 'This presentation is already running', 409);
      active.add(key);
      let receipt;
      try {
        signal?.throwIfAborted();
        const previous = await receipts.findByContextKey(sessionId, contextKey);
        if (previous) {
          if (DONE.has(previous.status)) return publicReceipt(previous);
          fail(['prepared', 'assembling', 'rendering'].includes(previous.status) ? 'PRESENTATION_BUSY' : 'PRESENTATION_FAILED', 'This context already has a presentation attempt; use a new context for an explicit retry', 409);
        }
        const initial = await store.snapshot();
        const selected = await store.binding(sessionId);
        if (!selected) fail('BINDING_NOT_FOUND', 'No preset is bound to this session', 404);
        const binding = snapshot(selected);
        await checkCurrent(sessionId, initial.revision, binding);
        const models = await modelsFor(sessionId, baseModel);
        const actualModels = structuredClone(models);
        signal?.throwIfAborted();
        receipt = await receipts.create({
          sessionId, contextKey, status: 'prepared', stageId: STAGES.assemble, text: '',
          packet, recentProse: prose, profile: binding.profile, overlay: binding.overlay,
          revision: initial.revision, profileId: binding.profileId, profileVersion: binding.version,
          profileHash: hash(binding.profile), models,
        });
        await emit({ sessionId, presentationId: receipt.id, stageId: STAGES.assemble, status: 'prepared', models });
        receipt = await receipts.update(receipt.id, { status: 'assembling' });
        await emit({ sessionId, presentationId: receipt.id, stageId: STAGES.assemble, status: 'assembling' });
        let overlay = snapshot(binding.overlay);
        let operations = [];
        let feedback = { entries: [], diagnostics: compileProfile(binding.profile, overlay, { variables: packet.variables ?? {} }).diagnostics };
        let compiled;
        let committed = false;
        for (let step = 0; step < maxAssemblySteps; step++) {
          signal?.throwIfAborted();
          receipt = await receipts.update(receipt.id, { assemblyAttempts: step + 1 });
          const result = await callModel({ sessionId, stageId: STAGES.assemble, config: models.assemble, system: ASSEMBLE_SYSTEM,
            input: snapshot({ packet, catalog: catalog(binding.profile, overlay), feedback, step: step + 1, maxSteps: maxAssemblySteps }), signal });
          signal?.throwIfAborted();
          actualModels.assemble = actualConfig(models.assemble, result.config);
          receipt = await receipts.update(receipt.id, { models: actualModels });
          try {
            const response = stageJson(result.text);
            keys(response, ['read', 'operations', 'commit'], 'INVALID_ASSEMBLY_RESPONSE');
            if (typeof response.commit !== 'boolean' || (has(response, 'read') && (!Array.isArray(response.read) || response.read.some((id) => typeof id !== 'string')))) fail('INVALID_ASSEMBLY_RESPONSE', 'Assembly requires a boolean commit and optional entry ids');
            const candidate = applyAgentOperations(binding.profile, overlay, response.operations ?? []);
            const effective = effectiveEntries(binding.profile, candidate);
            const requested = [...new Set(response.read ?? [])].map((id) => {
              const entry = effective.find((entry) => entry.id === id);
              if (!entry) fail('UNKNOWN_ENTRY', 'An assembly read referenced an unknown entry');
              return readableEntry(entry);
            });
            overlay = candidate;
            operations = [...operations, ...structuredClone(response.operations ?? [])];
            compiled = compileProfile(binding.profile, overlay, { variables: packet.variables ?? {} });
            feedback = { entries: requested, diagnostics: compiled.diagnostics };
            if (!response.commit || compiled.blocked) continue;
            await checkCurrent(sessionId, initial.revision, binding);
            if (operations.length) {
              const saved = await store.applyOperations(sessionId, operations, { expectedRevision: initial.revision });
              overlay = snapshot(saved.overlay);
              compiled = compileProfile(binding.profile, overlay, { variables: packet.variables ?? {} });
              if (compiled.blocked) fail('COMPILE_BLOCKED', 'The committed preset composition is blocked', 409);
              receipt = await receipts.update(receipt.id, { overlayRevision: saved.revision });
            }
            committed = true;
            break;
          } catch (error) {
            if (!(error instanceof PresetError) || ['REVISION_CONFLICT', 'BINDING_CONFLICT', 'COMPILE_BLOCKED'].includes(error.code)) throw error;
            feedback = { entries: [], diagnostics: [{ code: error.code, severity: 'error', message: 'The requested assembly step was rejected; correct the request without bypassing owner policy' }] };
          }
        }
        if (!committed) fail('ASSEMBLY_LIMIT', 'No valid preset composition was committed within the assembly limit', 409);
        signal?.throwIfAborted();
        const composition = snapshot({ packet, profile: binding.profile, overlay, compiled, models: actualModels, recentProse: prose });
        receipt = await receipts.update(receipt.id, { status: 'rendering', stageId: STAGES.render, overlay: composition.overlay, compiled: composition.compiled });
        await emit({ sessionId, presentationId: receipt.id, stageId: STAGES.render, status: 'rendering', model: models.render });
        const gate = thoughtGate(async (delta) => {
          signal?.throwIfAborted();
          await emit({ sessionId, presentationId: receipt.id, stageId: STAGES.render, status: 'rendering', delta });
        });
        let streamed = false;
        const writer = await callModel({ sessionId, stageId: STAGES.render, config: models.render, system: RENDER_SYSTEM,
          input: snapshot({ packet: composition.packet, modules: composition.compiled.messages, recentProse: composition.recentProse }), signal,
          onText: async (delta) => { streamed = true; await gate.push(delta); },
        });
        signal?.throwIfAborted();
        if (!streamed) await gate.push(writer.text);
        const text = await gate.end();
        if (!text.trim()) fail('EMPTY_NARRATIVE', 'The writer returned no public narrative', 502);
        const truncated = writer.finish?.kind === 'max-tokens';
        actualModels.render = actualConfig(models.render, writer.config);
        receipt = await receipts.update(receipt.id, { status: 'rendered', text, truncated, renderFinish: writer.finish?.kind ?? 'stop', models: actualModels });
        await emit({ sessionId, presentationId: receipt.id, stageId: STAGES.render, status: 'rendered', truncated });
        return publicReceipt(receipt);
      } catch (error) {
        if (receipt) await markFailed(receipt, error, sessionId);
        if (signal?.aborted) signal.throwIfAborted();
        if (error instanceof PresetError || error?.name === 'AbortError') throw error;
        fail('PRESENTATION_FAILED', 'The presentation attempt failed', 502);
      } finally { active.delete(key); }
    },

    async migrate({ sessionId, profileId, version, expectedRevision, baseModel, signal } = {}) {
      nonempty(sessionId, 'Session id');
      nonempty(profileId, 'Profile id');
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('EXPECTED_REVISION_REQUIRED', 'A nonnegative expectedRevision is required');
      if ((await store.snapshot()).revision !== expectedRevision) fail('REVISION_CONFLICT', 'The preset changed before migration started', 409);
      const profile = await store.profile(profileId, version);
      if (!profile) fail('PROFILE_NOT_FOUND', 'The selected profile version does not exist', 404);
      const source = profile.sourceId === null ? null : await store.source(profile.sourceId);
      if (profile.sourceId !== null && !source) fail('SOURCE_NOT_FOUND', 'The immutable preset source does not exist', 404);
      const sourceMetadata = sourceMetadataProjection(profile, source);
      if (typeof skillText !== 'string' || !skillText.trim()) fail('MIGRATION_SKILL_REQUIRED', 'Preset migration requires the bundled adaptation skill', 503);
      const models = await modelsFor(sessionId, baseModel);
      const system = `RP_LAST_STEP_MIGRATE\n${skillText}\n${skillReference}\n
This runtime accepts a minimal patch only: {updates:[{id,name?,content?,phase?,role?,order?,enabled?,marker?,fills?}],additions:[Entry],report:{summary,changes?,blocked?,diagnostics?}}.
All original entries are retained programmatically. Preserve ids, source references, locks, required policy and default-off state. Do not send protected fields in updates. Added entries are optional and unlocked; a split addition may use source:{entryId:existingId,reason:string}. Never add an override to bypass a locked entry.
Classify responsibilities as agent/render/shared, retaining unclassified only for unresolved adaptation. Split simulation instructions out of render modules. Unknown macros/extensions and STJS/regex/depth behavior remain inert and must be reported; do not claim exact runtime parity.
sourceMetadata supplies immutable original insertion rules, selected/full prompt orders and inert extension settings. Compare them with current entry content and explicit owner policy. Its unsupportedFeatures remain unresolved unless this runtime actually provides the required capability; script-body descriptors do not supply executable behavior.
Return an owner-review draft and candid blockers, never ready/bind/execute. The model has no world-state tools. Only the selected preset is provided, not private simulation state.`;
      let repair;
      let candidate;
      let report;
      await emit({ sessionId, stageId: STAGES.migrate, status: 'assembling', model: models.migrate });
      try {
        for (let attempt = 0; attempt < maxMigrationAttempts; attempt++) {
          signal?.throwIfAborted();
          const response = await callModel({ sessionId, stageId: STAGES.migrate, config: models.migrate, system,
            input: snapshot({ profile: { id: profile.id, name: profile.name, version: profile.version, status: profile.status, sourceId: profile.sourceId, entries: profile.entries.map(readableEntry) }, sourceMetadata, ...(repair ? { repair } : {}), attempt: attempt + 1, maxAttempts: maxMigrationAttempts }), signal });
          signal?.throwIfAborted();
          try {
            const result = migrationCandidate(profile, stageJson(response.text));
            candidate = result.profile;
            report = result.report;
            break;
          } catch (error) {
            if (!(error instanceof PresetError)) throw error;
            if (error.status === 403) {
              candidate = validateProfile({ ...profile, status: 'draft' });
              report = { summary: 'Migration patch rejected because it conflicts with owner policy; original modules retained for review.', blocked: [{ code: error.code, ...(error.entryId === undefined ? {} : { entryId: error.entryId }) }] };
              break;
            }
            repair = { code: error.code, message: 'Return a corrected minimal JSON patch matching the documented schema; preserve original entries and owner policy' };
          }
        }
        if (!candidate) fail('MIGRATION_LIMIT', 'The model did not return a valid migration draft within the attempt limit', 409);
        signal?.throwIfAborted();
        const compiled = compileProfile(candidate, emptyOverlay(), { allowDraft: true });
        report = snapshot({ ...report, diagnostics: [...(report.diagnostics ?? []), ...sourceMetadata.unsupportedFeatures, ...compiled.diagnostics], source: { id: sourceMetadata.id, format: sourceMetadata.format, ...(sourceMetadata.sha256 ? { sha256: sourceMetadata.sha256 } : {}) }, validation: 'Structure checked. Semantic model behavior and full SillyTavern runtime compatibility require owner review.' });
        const saved = await store.saveProfile({ ...candidate, id: profile.id, name: profile.name, sourceId: profile.sourceId, status: 'draft', migrationReport: report }, { expectedRevision });
        await emit({ sessionId, stageId: STAGES.migrate, status: 'rendered', profileId: saved.profileId, profileVersion: saved.version });
        return { ...saved, report };
      } catch (error) {
        try { await emit({ sessionId, stageId: STAGES.migrate, status: error?.name === 'AbortError' ? 'cancelled' : 'failed', code: error instanceof PresetError ? error.code : 'MIGRATION_FAILED' }); } catch { /* Keep original failure. */ }
        if (signal?.aborted) signal.throwIfAborted();
        if (error instanceof PresetError || error?.name === 'AbortError') throw error;
        fail('MIGRATION_FAILED', 'The selected preset could not be migrated', 502);
      }
    },

    async commit({ sessionId, presentationId, seq } = {}) {
      const receipt = await owned(sessionId, presentationId);
      if (receipt.status === 'complete') return publicReceipt(receipt);
      if (receipt.status !== 'rendered') fail('PRESENTATION_NOT_RENDERED', 'Only a rendered presentation can be committed', 409);
      if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0)) fail('INVALID_SEQUENCE', 'Canonical sequence must be a nonnegative integer');
      const updated = await receipts.update(receipt.id, { status: 'complete', ...(seq === undefined ? {} : { seq }) });
      await emit({ sessionId, presentationId: receipt.id, stageId: STAGES.render, status: 'complete', committed: true, ...(seq === undefined ? {} : { seq }) });
      return publicReceipt(updated);
    },

    async fail({ sessionId, presentationId, contextKey, error } = {}) {
      const receipt = presentationId ? await owned(sessionId, presentationId) : contextKey ? await receipts.findByContextKey(sessionId, contextKey) : null;
      if (!receipt) return null;
      if (receipt.status === 'complete') return publicReceipt(receipt);
      return markFailed(receipt, error, sessionId);
    },

    async state(sessionId) { return (await receipts.list(sessionId)).map(publicReceipt); },
  });
}
