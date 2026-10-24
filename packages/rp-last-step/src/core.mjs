import { createHash, randomUUID } from 'node:crypto';

const ROLES = new Set(['system', 'user', 'assistant']);
const PHASES = new Set(['unclassified', 'agent', 'render', 'shared']);
const SLOT = /^[A-Za-z0-9_.-]+$/u;
const has = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class PresetError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PresetError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new PresetError(code, message, status);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot(value) {
  return freeze(structuredClone(value));
}

function string(value, label, code = 'INVALID_PROFILE') {
  if (typeof value !== 'string' || value.trim().length === 0) fail(code, `${label} must be a nonempty string`);
  return value;
}

function boolean(value, fallback, label, code = 'INVALID_PROFILE') {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(code, `${label} must be boolean`);
  return value;
}

function slots(content) {
  return new Set([...content.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/gu)].map((match) => match[1]));
}

function fills(value, content, code) {
  if (!record(value)) fail(code, 'fills must be an object');
  const known = slots(content);
  for (const [key, fill] of Object.entries(value)) {
    if (!SLOT.test(key) || !known.has(key) || typeof fill !== 'string') {
      fail('INVALID_FILL', `Fill ${key} must be a string for a slot in this entry`);
    }
  }
  return structuredClone(value);
}

function normalizeEntry(input, index) {
  if (!record(input)) fail('INVALID_PROFILE', 'Each entry must be an object');
  const id = string(input.id, 'Entry id');
  const content = input.content ?? '';
  const role = input.role ?? 'system';
  const phase = input.phase ?? 'unclassified';
  const order = input.order ?? index;
  if (typeof content !== 'string' || !ROLES.has(role) || !PHASES.has(phase) || !Number.isFinite(order)) {
    fail('INVALID_PROFILE', `Invalid content, role, phase or order for entry ${id}`);
  }
  const entry = {
    ...structuredClone(input), id, name: string(input.name ?? id, 'Entry name'), content, role, order,
    enabled: boolean(input.enabled, true, 'Entry enabled'), phase,
    required: boolean(input.required, false, 'Entry required'), locked: boolean(input.locked, false, 'Entry locked'),
  };
  if (entry.required && !entry.enabled) fail('INVALID_PROFILE', `Required entry ${id} must be enabled`);
  if (has(input, 'marker')) entry.marker = boolean(input.marker, false, 'Entry marker');
  if (has(input, 'source') && (!record(input.source) || typeof input.source.entryId !== 'string')) {
    fail('INVALID_PROFILE', `Invalid source reference for entry ${id}`);
  }
  if (has(input, 'fills')) entry.fills = fills(input.fills, content, 'INVALID_PROFILE');
  return entry;
}

export function validateProfile(input) {
  if (!record(input) || !Array.isArray(input.entries)) fail('INVALID_PROFILE', 'Profile entries must be an array');
  const id = string(input.id, 'Profile id');
  const name = string(input.name, 'Profile name');
  const version = input.version ?? 1;
  const status = input.status ?? 'draft';
  const sourceId = input.sourceId ?? null;
  if (!Number.isSafeInteger(version) || version < 1 || !['draft', 'ready'].includes(status) || (sourceId !== null && typeof sourceId !== 'string')) {
    fail('INVALID_PROFILE', 'Invalid profile version, status or sourceId');
  }
  const seen = new Set();
  const entries = input.entries.map((entry, index) => {
    const normalized = normalizeEntry(entry, index);
    if (seen.has(normalized.id)) fail('DUPLICATE_ENTRY', `Duplicate entry ${normalized.id}`);
    seen.add(normalized.id);
    return normalized;
  });
  return snapshot({ ...input, id, name, version, status, sourceId, entries });
}

export function createProfile({ id = randomUUID(), name } = {}) {
  return validateProfile({ id, name, version: 1, status: 'draft', sourceId: null, entries: [] });
}

function diagnostic(code, message, entryId, severity = 'error') {
  return { code, severity, message, ...(entryId === undefined ? {} : { entryId }) };
}

export function importSillyTavern(rawText, { id = randomUUID(), name, orderCharacterId } = {}) {
  if (typeof rawText !== 'string') fail('INVALID_PRESET', 'SillyTavern source must be JSON text');
  let input;
  try {
    input = JSON.parse(rawText.replace(/^\uFEFF/u, ''));
  } catch {
    fail('INVALID_PRESET', 'SillyTavern source is not valid JSON');
  }
  if (!record(input) || !Array.isArray(input.prompts)) fail('INVALID_PRESET', 'SillyTavern prompts must be an array');
  const diagnostics = [];
  const orderPresent = has(input, 'prompt_order');
  if (orderPresent && !Array.isArray(input.prompt_order)) fail('INVALID_ORDER', 'prompt_order must be an array');
  const groups = input.prompt_order ?? [];
  let selected;
  if (orderCharacterId !== undefined) {
    selected = groups.find((group) => record(group) && String(group.character_id) === String(orderCharacterId));
    if (!selected) fail('INVALID_ORDER', `No prompt_order for character ${orderCharacterId}`);
  } else {
    selected = groups.find((group) => record(group) && String(group.character_id) === '100001') ?? groups[0];
    if (groups.length > 1) diagnostics.push(diagnostic('ORDER_SELECTED', `Selected prompt_order character ${selected?.character_id ?? '(unspecified)'}`, undefined, 'warning'));
  }
  if (selected !== undefined && (!record(selected) || !Array.isArray(selected.order))) fail('INVALID_ORDER', 'Selected prompt_order must contain an order array');
  const order = selected?.order ?? [];
  const schedule = new Map();
  for (let index = 0; index < order.length; index++) {
    const row = order[index];
    if (!record(row) || row.identifier === undefined) fail('INVALID_ORDER', 'Each prompt_order item needs an identifier');
    const entryId = String(row.identifier);
    if (schedule.has(entryId)) fail('INVALID_ORDER', `Duplicate prompt_order entry ${entryId}`);
    schedule.set(entryId, { row, index, enabled: boolean(row.enabled, false, 'prompt_order enabled', 'INVALID_ORDER') });
  }
  const entries = input.prompts.map((prompt, index) => {
    if (!record(prompt)) fail('INVALID_PRESET', 'Each ST prompt must be an object');
    const entryId = String(prompt.identifier ?? `prompt-${index + 1}`);
    const scheduled = schedule.get(entryId);
    if (prompt.role !== undefined && !ROLES.has(prompt.role)) diagnostics.push(diagnostic('UNSUPPORTED_ROLE', `Role ${prompt.role} retained in source; draft uses system`, entryId, 'warning'));
    if (prompt.injection_position !== undefined || prompt.injection_depth !== undefined || prompt.injection_order !== undefined) {
      diagnostics.push(diagnostic('INJECTION_REQUIRES_ADAPTATION', 'ST injection metadata is retained; this kernel orders static messages only', entryId, 'warning'));
    }
    return {
      id: entryId, name: typeof prompt.name === 'string' && prompt.name.trim() ? prompt.name : entryId,
      content: prompt.content ?? '', role: ROLES.has(prompt.role) ? prompt.role : 'system',
      order: scheduled?.index ?? (orderPresent ? order.length + index : index),
      enabled: orderPresent ? scheduled?.enabled ?? false : boolean(prompt.enabled, true, 'Prompt enabled', 'INVALID_PRESET'),
      phase: 'unclassified', required: false, locked: false, marker: prompt.marker === true,
      source: {
        entryId, format: 'sillytavern', index, originalPrompt: structuredClone(prompt),
        promptOrder: scheduled ? structuredClone(scheduled.row) : null,
        orderCharacterId: selected?.character_id ?? null,
      },
    };
  });
  const entryIds = new Set(entries.map((entry) => entry.id));
  for (const entryId of schedule.keys()) {
    if (!entryIds.has(entryId)) fail('INVALID_ORDER', `prompt_order references absent prompt ${entryId}`);
  }
  if (has(input, 'extensions') || has(input, 'regex_scripts') || has(input, 'tavern_helper_scripts')) {
    diagnostics.push(diagnostic('EXTENSIONS_INERT', 'Original extensions are retained in rawText and will not execute', undefined, 'warning'));
  }
  const source = { id: string(id, 'Source id', 'INVALID_PRESET'), format: 'sillytavern', rawText, sha256: createHash('sha256').update(rawText, 'utf8').digest('hex') };
  const profile = validateProfile({ id: randomUUID(), name: name ?? input.name ?? 'Imported SillyTavern preset', version: 1, status: 'draft', sourceId: source.id, entries });
  return snapshot({ source, profile, diagnostics });
}

export function emptyOverlay() {
  return snapshot({ entries: {}, additions: [] });
}

function onlyKeys(value, allowed, code) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(code, 'Unexpected fields');
}

function temporary(input, index) {
  if (!record(input)) fail('INVALID_OVERLAY', 'Temporary entry must be an object');
  onlyKeys(input, ['id', 'name', 'content', 'role', 'order', 'enabled', 'phase', 'required', 'locked', 'fills'], 'INVALID_OVERLAY');
  if ((input.phase !== undefined && input.phase !== 'render') || input.required === true || input.locked === true) {
    fail('INVALID_OVERLAY', 'Temporary entries must be render entries, optional and unlocked', 403);
  }
  return normalizeEntry({ ...input, phase: 'render', required: false, locked: false }, index);
}

function validateOverlay(profile, overlay) {
  onlyKeys(overlay, ['entries', 'additions'], 'INVALID_OVERLAY');
  if (!record(overlay.entries) || !Array.isArray(overlay.additions)) fail('INVALID_OVERLAY', 'Overlay requires entries and additions');
  const byId = new Map(profile.entries.map((entry) => [entry.id, entry]));
  const additions = overlay.additions.map((entry, index) => {
    const normalized = temporary(entry, profile.entries.length + index);
    if (byId.has(normalized.id)) fail('DUPLICATE_ENTRY', `Temporary entry shadows ${normalized.id}`);
    byId.set(normalized.id, normalized);
    return normalized;
  });
  const patches = [];
  for (const [entryId, patch] of Object.entries(overlay.entries)) {
    const original = byId.get(entryId);
    if (!original) fail('UNKNOWN_ENTRY', `Unknown entry ${entryId}`);
    onlyKeys(patch, ['enabled', 'content', 'fills'], 'INVALID_OVERLAY');
    if (original.locked && Object.keys(patch).length > 0) fail('ENTRY_LOCKED', `Entry ${entryId} is locked`, 403);
    if (has(patch, 'enabled')) {
      boolean(patch.enabled, original.enabled, 'Overlay enabled', 'INVALID_OVERLAY');
      if (original.required && !patch.enabled) fail('ENTRY_REQUIRED', `Entry ${entryId} is required`, 403);
    }
    if (has(patch, 'content') && typeof patch.content !== 'string') fail('INVALID_OVERLAY', 'Replacement content must be a string');
    if (has(patch, 'fills')) fills(patch.fills, patch.content ?? original.content, 'INVALID_OVERLAY');
    patches.push([entryId, structuredClone(patch)]);
  }
  return { entries: Object.fromEntries(patches), additions };
}

export function applyAgentOperations(input, current, operations) {
  const profile = validateProfile(input);
  let overlay = validateOverlay(profile, current);
  if (!Array.isArray(operations)) fail('INVALID_OPERATION', 'Operations must be an array');
  for (const operation of operations) {
    if (!record(operation)) fail('INVALID_OPERATION', 'Each operation must be an object');
    const allowed = {
      enable: ['op', 'entryId'], disable: ['op', 'entryId'], replace: ['op', 'entryId', 'content'],
      fill: ['op', 'entryId', 'key', 'value'], add: ['op', 'entry'], remove: ['op', 'entryId'],
    };
    if (!has(allowed, operation.op)) fail('INVALID_OPERATION', `Unsupported operation ${operation.op}`);
    onlyKeys(operation, allowed[operation.op], 'INVALID_OPERATION');
    if (operation.op === 'add') {
      overlay.additions.push(temporary(operation.entry, profile.entries.length + overlay.additions.length));
    } else {
      const entryId = string(operation.entryId, 'Operation entryId', 'INVALID_OPERATION');
      const source = profile.entries.find((entry) => entry.id === entryId);
      const addition = overlay.additions.find((entry) => entry.id === entryId);
      const entry = source ?? addition;
      if (!entry) fail('UNKNOWN_ENTRY', `Unknown entry ${entryId}`);
      if (operation.op === 'remove') {
        if (source) fail('SOURCE_ENTRY', 'Only temporary entries can be removed', 403);
        overlay.additions = overlay.additions.filter((item) => item.id !== entryId);
        delete overlay.entries[entryId];
      } else {
        if (entry.locked) fail('ENTRY_LOCKED', `Entry ${entryId} is locked`, 403);
        const patch = has(overlay.entries, entryId) ? overlay.entries[entryId] : {};
        if (operation.op === 'enable' || operation.op === 'disable') {
          if (operation.op === 'disable' && entry.required) fail('ENTRY_REQUIRED', `Entry ${entryId} is required`, 403);
          patch.enabled = operation.op === 'enable';
        } else if (operation.op === 'replace') {
          if (typeof operation.content !== 'string') fail('INVALID_OPERATION', 'Replacement content must be a string');
          patch.content = operation.content;
        } else {
          if (typeof operation.key !== 'string' || typeof operation.value !== 'string') fail('INVALID_FILL', 'Fill key and value must be strings');
          patch.fills = Object.fromEntries([...Object.entries(patch.fills ?? {}), [operation.key, operation.value]]);
          fills(patch.fills, patch.content ?? entry.content, 'INVALID_FILL');
        }
        Object.defineProperty(overlay.entries, entryId, { value: patch, enumerable: true, writable: true, configurable: true });
      }
    }
    overlay = validateOverlay(profile, overlay);
  }
  return snapshot(overlay);
}

export function compileProfile(input, current = emptyOverlay(), { phase = 'render', variables = {}, allowDraft = false } = {}) {
  const profile = validateProfile(input);
  if (!['agent', 'render'].includes(phase)) fail('INVALID_PHASE', 'Compile phase must be agent or render');
  if (!record(variables)) fail('INVALID_VARIABLES', 'Compile variables must be an object');
  const overlay = validateOverlay(profile, current);
  const diagnostics = [];
  if (profile.status !== 'ready' && !allowDraft) diagnostics.push(diagnostic('PROFILE_DRAFT', 'Adapt and mark this profile ready before production use'));
  const entries = [];
  const all = [...profile.entries, ...overlay.additions].map((original) => {
    const patch = has(overlay.entries, original.id) ? overlay.entries[original.id] : {};
    return { ...original, ...patch, fills: { ...original.fills, ...patch.fills } };
  }).sort((left, right) => left.order - right.order);
  for (const entry of all) {
    if (!entry.enabled) continue;
    if (entry.phase === 'unclassified') {
      diagnostics.push(diagnostic('UNCLASSIFIED_ENTRY', 'Active entry must be adapted to a phase', entry.id));
      continue;
    }
    if (entry.phase !== 'shared' && entry.phase !== phase) continue;
    let content = entry.content;
    if (entry.marker && content.length === 0) {
      const key = entry.source?.entryId ?? entry.id;
      if (has(variables, key) && typeof variables[key] === 'string') content = variables[key];
      else diagnostics.push(diagnostic('UNMAPPED_MARKER', `Marker ${key} needs an explicit runtime value or adapted content`, entry.id));
    }
    content = content.replace(/\{\{([^{}]*)\}\}/gu, (macro, inner) => {
      const key = inner.trim();
      if (!SLOT.test(key)) return macro;
      if (entry.locked && has(entry.fills, key)) return entry.fills[key];
      if (has(variables, key) && ['string', 'number', 'boolean'].includes(typeof variables[key])) return String(variables[key]);
      if (has(entry.fills, key)) return entry.fills[key];
      return macro;
    });
    if (content.includes('{{') || content.includes('}}')) diagnostics.push(diagnostic('UNRESOLVED_MACRO', 'Unresolved or unsupported macro requires adaptation or an explicit runtime value', entry.id));
    if (entry.required && content.trim().length === 0) diagnostics.push(diagnostic('REQUIRED_EMPTY', 'Required entry must contribute nonempty content', entry.id));
    entries.push({ ...entry, content });
  }
  const messages = entries.map(({ role, content }) => ({ role, content }));
  return snapshot({
    blocked: diagnostics.some(({ severity }) => severity === 'error'), diagnostics, entries, messages,
    text: messages.map(({ content }) => content).join('\n\n'),
    hash: createHash('sha256').update(JSON.stringify({ phase, messages })).digest('hex'),
  });
}
