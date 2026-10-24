import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  PresetError, applyAgentOperations, emptyOverlay, importSillyTavern, validateProfile,
} from './core.mjs';

// All handles for the same directory share the mutation queue in this process.
const queues = new Map();
const has = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function put(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function detached(value) {
  return structuredClone(value);
}

function requireId(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new PresetError('INVALID_ID', `${label} must be a nonempty string`);
}

function selectedProfile(state, id, version) {
  const versions = has(state.profiles, id) ? state.profiles[id] : [];
  return version === undefined ? versions.at(-1) ?? null : versions.find((profile) => profile.version === version) ?? null;
}

export async function createPresetStore({ directory } = {}) {
  requireId(directory, 'Store directory');
  const root = resolve(directory);
  const file = join(root, 'preset-store.json');
  await mkdir(root, { recursive: true });

  async function readState() {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, revision: 0, sources: {}, profiles: {}, bindings: {} };
      throw error;
    }
    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      throw new PresetError('STORE_CORRUPT', 'Preset store is not valid JSON', 500);
    }
    if (!record(state) || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !record(state.sources) || !record(state.profiles) || !record(state.bindings)) {
      throw new PresetError('STORE_CORRUPT', 'Preset store has an invalid structure', 500);
    }
    return state;
  }

  async function writeState(state) {
    const temporary = join(root, `.preset-store-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  function serial(work) {
    const pending = (queues.get(root) ?? Promise.resolve()).then(work);
    const settled = pending.then(() => undefined, () => undefined);
    queues.set(root, settled);
    void settled.then(() => { if (queues.get(root) === settled) queues.delete(root); });
    return pending;
  }

  function read(work) {
    return serial(async () => detached(await work(await readState())));
  }

  function mutate(expectedRevision, work) {
    return serial(async () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new PresetError('EXPECTED_REVISION_REQUIRED', 'A nonnegative expectedRevision is required');
      }
      const state = await readState();
      if (expectedRevision !== state.revision) throw new PresetError('REVISION_CONFLICT', `Expected revision ${expectedRevision}; current revision is ${state.revision}`, 409);
      const result = work(state);
      state.revision++;
      await writeState(state);
      return detached({ revision: state.revision, ...result });
    });
  }

  await serial(readState);
  return Object.freeze({
    snapshot() {
      return read((state) => ({
        revision: state.revision,
        sources: Object.values(state.sources),
        profiles: Object.values(state.profiles).map((versions) => versions.at(-1)),
        bindings: state.bindings,
      }));
    },

    importSource(rawText, { name, orderCharacterId, expectedRevision } = {}) {
      return mutate(expectedRevision, (state) => {
        const { source, profile } = importSillyTavern(rawText, { name, orderCharacterId });
        put(state.sources, source.id, source);
        put(state.profiles, profile.id, [profile]);
        return { profileId: profile.id, version: profile.version };
      });
    },

    saveProfile(input, { expectedRevision } = {}) {
      // Capture caller data before a pending write permits further caller edits.
      const captured = detached(input);
      return mutate(expectedRevision, (state) => {
        const validated = validateProfile(captured);
        if (validated.sourceId !== null && !has(state.sources, validated.sourceId)) throw new PresetError('SOURCE_NOT_FOUND', `Unknown source ${validated.sourceId}`, 404);
        const previous = selectedProfile(state, validated.id);
        if (previous && captured.version !== previous.version) {
          throw new PresetError('PROFILE_VERSION_CONFLICT', `Profile ${validated.id} is based on version ${captured.version ?? '(unspecified)'}; latest version is ${previous.version}`, 409);
        }
        const profile = validateProfile({ ...validated, version: previous ? previous.version + 1 : 1 });
        const versions = has(state.profiles, profile.id) ? state.profiles[profile.id] : [];
        put(state.profiles, profile.id, [...versions, profile]);
        return { profileId: profile.id, version: profile.version };
      });
    },

    bindSession(sessionId, { profileId, version, expectedRevision } = {}) {
      return mutate(expectedRevision, (state) => {
        requireId(sessionId, 'Session id');
        requireId(profileId, 'Profile id');
        const profile = selectedProfile(state, profileId, version);
        if (!profile) throw new PresetError('PROFILE_NOT_FOUND', `Unknown profile version ${profileId}:${version ?? 'latest'}`, 404);
        if (profile.status !== 'ready' || profile.entries.some((entry) => entry.enabled && entry.phase === 'unclassified')) {
          throw new PresetError('PROFILE_NOT_READY', 'Session bindings require an adapted ready profile', 409);
        }
        put(state.bindings, sessionId, { profileId: profile.id, version: profile.version, overlay: emptyOverlay() });
        return {};
      });
    },

    applyOperations(sessionId, operations, { expectedRevision } = {}) {
      const captured = detached(operations);
      return mutate(expectedRevision, (state) => {
        requireId(sessionId, 'Session id');
        const binding = has(state.bindings, sessionId) ? state.bindings[sessionId] : null;
        if (!binding) throw new PresetError('BINDING_NOT_FOUND', `No preset bound to session ${sessionId}`, 404);
        const profile = selectedProfile(state, binding.profileId, binding.version);
        if (!profile) throw new PresetError('STORE_CORRUPT', 'Bound profile version is missing', 500);
        const overlay = applyAgentOperations(profile, binding.overlay, captured);
        put(state.bindings, sessionId, { ...binding, overlay });
        return { overlay };
      });
    },

    profile(id, version) {
      return read((state) => selectedProfile(state, id, version));
    },

    source(id) {
      return read((state) => has(state.sources, id) ? state.sources[id] : null);
    },

    binding(sessionId) {
      return read((state) => {
        const binding = has(state.bindings, sessionId) ? state.bindings[sessionId] : null;
        if (!binding) return null;
        const profile = selectedProfile(state, binding.profileId, binding.version);
        if (!profile) throw new PresetError('STORE_CORRUPT', 'Bound profile version is missing', 500);
        return { ...binding, profile };
      });
    },
  });
}
