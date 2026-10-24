import { PresetError } from './core.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value) => typeof value === 'string' && Boolean(value.trim()) && value.length <= 256;
const revision = (value) => Number.isSafeInteger(value) && value >= 0;
const version = (value) => Number.isSafeInteger(value) && value >= 1;
const fields = {
  state: ['sessionId'], profile: ['profileId', 'version'], source: ['sourceId'],
  createProfile: ['name', 'expectedRevision'], importSillyTavern: ['rawText', 'name', 'orderCharacterId', 'expectedRevision'],
  saveProfile: ['profile', 'expectedRevision'], bindSession: ['sessionId', 'profileId', 'version', 'expectedRevision'],
  preview: ['profile', 'sessionId', 'phase', 'variables'], migrate: ['sessionId', 'profileId', 'version', 'expectedRevision'],
};
const writes = new Set(['createProfile', 'importSillyTavern', 'saveProfile', 'bindSession', 'migrate']);
const failure = (status, code, message, diagnostics) => Response.json({ error: { code, message, ...(diagnostics === undefined ? {} : { diagnostics }) } }, { status, headers: { 'cache-control': 'no-store' } });

function errorResponse(error) {
  if (error instanceof PresetError) return failure(error.status, error.code, error.message, error.diagnostics);
  if (['session/not-found', 'session-query/not-found'].includes(error?.code)) return failure(404, 'SESSION_NOT_FOUND', 'Session is unavailable');
  if (['gateway/forbidden', 'gateway/access-denied'].includes(error?.code)) return failure(403, 'FORBIDDEN', 'Session access was denied');
  if (error?.name === 'AbortError' || error?.code === 'gateway/cancelled') return failure(499, 'CANCELLED', 'The request was cancelled');
  return failure(503, 'UNAVAILABLE', 'RP presentation is temporarily unavailable');
}

function valid(input) {
  if (!object(input) || !Object.hasOwn(fields, input.action) || Object.keys(input).some((key) => key !== 'action' && !fields[input.action].includes(key))) return false;
  if (writes.has(input.action) && !revision(input.expectedRevision)) return false;
  if (['state', 'bindSession', 'migrate'].includes(input.action) && !id(input.sessionId)) return false;
  if (['profile', 'bindSession', 'migrate'].includes(input.action) && !id(input.profileId)) return false;
  if (input.version !== undefined && !version(input.version)) return false;
  if (['bindSession', 'migrate'].includes(input.action) && !version(input.version)) return false;
  if (input.action === 'source' && !id(input.sourceId)) return false;
  if (input.action === 'createProfile' && (typeof input.name !== 'string' || !input.name.trim())) return false;
  if (input.action === 'importSillyTavern' && (typeof input.rawText !== 'string'
    || (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim()))
    || (input.orderCharacterId !== undefined && typeof input.orderCharacterId !== 'string' && !Number.isFinite(input.orderCharacterId)))) return false;
  if (['saveProfile', 'preview'].includes(input.action) && !object(input.profile)) return false;
  if (input.action === 'preview' && (!['agent', 'render'].includes(input.phase) || (input.sessionId !== undefined && !id(input.sessionId))
    || (input.variables !== undefined && (!object(input.variables) || Object.values(input.variables).some((value) => typeof value !== 'string'))))) return false;
  return true;
}

function metadata(input, sessionId) {
  const event = { type: input?.type === 'changed' ? 'changed' : 'stage', sessionId };
  if (event.type === 'stage') {
    for (const key of ['presentationId', 'stageId', 'status', 'code']) if (typeof input?.[key] === 'string' && input[key].length <= 256) event[key] = input[key];
    if (input?.truncated === true) event.truncated = true;
  }
  return event;
}

/** Connection exact routes are owner-only; session reads still use owner Remote authorization. */
export function createRpLastStepRoutes(service) {
  let stopped = false;
  const streams = new Set();
  return {
    async request(request) {
      if (stopped) return failure(503, 'UNAVAILABLE', 'RP presentation has been unloaded');
      let input;
      try { input = await request.json(); } catch { return failure(400, 'INVALID_REQUEST', 'A JSON request is required'); }
      if (!valid(input)) return failure(400, 'INVALID_REQUEST', 'Invalid RP preset operation');
      try {
        request.signal.throwIfAborted();
        const { action, ...args } = input;
        const result = action === 'state' ? await service.state(input.sessionId, request.signal) : await service[action](args, request.signal);
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return errorResponse(error); }
    },
    async events(request) {
      if (stopped) return failure(503, 'UNAVAILABLE', 'RP presentation has been unloaded');
      const sessionId = new URL(request.url).searchParams.get('sessionId');
      if (!id(sessionId)) return failure(400, 'INVALID_REQUEST', 'A sessionId is required');
      try {
        await service.authorize(sessionId, request.signal);
        if (request.signal.aborted || stopped) return new Response(null, { status: 204 });
        let cleanup = () => {};
        const body = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            let closed = false;
            let unsubscribe = () => {};
            const writeBytes = (bytes) => {
              if (closed) return;
              if (controller.desiredSize < bytes.byteLength) { cleanup(); return; }
              controller.enqueue(bytes);
            };
            const write = (event) => writeBytes(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
            const timer = setInterval(() => writeBytes(encoder.encode(': heartbeat\n\n')), 15_000);
            timer.unref?.();
            const aborted = () => cleanup();
            cleanup = (cancelled) => {
              if (closed) return;
              closed = true;
              clearInterval(timer);
              unsubscribe();
              streams.delete(cleanup);
              request.signal.removeEventListener('abort', aborted);
              if (cancelled !== true) controller.close();
            };
            streams.add(cleanup);
            request.signal.addEventListener('abort', aborted, { once: true });
            unsubscribe = service.subscribe(sessionId, (event) => write(metadata(event, sessionId)));
            if (request.signal.aborted || stopped) cleanup();
            else write({ type: 'connected', sessionId });
          },
          cancel() { cleanup(true); },
        }, { highWaterMark: 16_384, size: (chunk) => chunk.byteLength });
        return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
      } catch (error) { return errorResponse(error); }
    },
    close() {
      if (stopped) return;
      stopped = true;
      for (const close of streams) close();
    },
  };
}
