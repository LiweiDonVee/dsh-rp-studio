import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { SecretLogBuffer, type LogEntry } from './log.js';
import { stripAnsi } from './lines.js';
import { nodeVersion, processIdentity } from './process.js';

export type SupervisorPhase = 'stopped' | 'starting' | 'running' | 'stopping'
export interface SupervisorConfig {
    nodeExecutable: string; dshBin: string; gatewayEntry: string; dshHome: string;
    dshPort: number; studioPort: number; cwd: string;
    startupTimeoutMs?: number; logLimitCharacters?: number;
}
export interface StartResult { studioUrl: string; dshUrl: string; launchUrl: string }
export interface ManagedChildProcess extends EventEmitter {
    readonly pid?: number | undefined; readonly stdout: Readable | null; readonly stderr: Readable | null;
    readonly exitCode: number | null; readonly signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals): boolean;
}
export interface ServiceSpec {
    service: 'dsh' | 'studio'; executable: string; args: string[]; cwd: string;
    env: NodeJS.ProcessEnv; port: number;
}
export interface ServiceStatus {
    service: 'dsh' | 'studio'; state: SupervisorPhase; healthy: boolean; pid?: number; url?: string;
}
export interface SupervisorDependencies {
    reservePort(requested: number): Promise<number>;
    spawn(spec: ServiceSpec): ManagedChildProcess;
    fetch(input: string, init?: RequestInit): Promise<Response>;
    killTree(child: ManagedChildProcess): Promise<void>;
}
export interface SupervisorStatus {
    phase: SupervisorPhase; studioUrl?: string; dshUrl?: string;
    processes: { dsh?: number; studio?: number };
    services: { dsh: ServiceStatus; studio: ServiceStatus };
    logs: LogEntry[]; lastError?: { code: SupervisorErrorCode; message: string };
}
export interface DoctorEntry {
    component: 'node' | 'dsh' | 'gateway' | 'home'; path: string; exists: boolean;
    version?: string; status: 'ready' | 'missing' | 'unhealthy' | 'not-running';
}
export interface DoctorResult {
    phase: SupervisorPhase;
    entries: DoctorEntry[];
    services: { dsh: 'ready' | 'not-running' | 'unhealthy'; studio: 'ready' | 'not-running' | 'unhealthy' };
}
export type SupervisorErrorCode = 'invalid-config' | 'missing-path' | 'home-locked' | 'port-occupied' | 'spawn-error' | 'child-exited' | 'startup-timeout' | 'startup-cancelled'
interface RuntimeState { dshUrl: string; studioUrl: string; launchUrl: string }
interface LockRecord { owner: string; pid: number; identity?: string }
export class SupervisorError extends Error {
    readonly code: SupervisorErrorCode;
    name = 'SupervisorError';
    constructor(code: SupervisorErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}
const HOST = '127.0.0.1';
const LOCK_NAME = '.dsh-rp-supervisor.lock';
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
function validPort(port: number): boolean {
    return Number.isInteger(port) && port >= 0 && port <= 65_535;
}
async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path, constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function reservePort(requested: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.once('error', reject);
        server.listen(requested, HOST, () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('TCP port allocation returned no address'));
                return;
            }
            server.close(error => error ? reject(error) : resolve(address.port));
        });
    });
}
async function waitForExit(child: ManagedChildProcess, timeoutMs = 500): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null)
        return;
    await Promise.race([
        new Promise<void>(resolve => child.once('exit', () => resolve())),
        new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
}
async function killOwnedTree(child: ManagedChildProcess): Promise<void> {
    const pid = child.pid;
    if (!pid || child.exitCode !== null || child.signalCode !== null)
        return;
    if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
        });
        await waitForExit(killer);
    }
    else {
        try {
            process.kill(-pid, 'SIGTERM');
        }
        catch {
            child.kill('SIGTERM');
        }
    }
    await waitForExit(child);
    if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32')
            child.kill('SIGKILL');
        else {
            try {
                process.kill(-pid, 'SIGKILL');
            }
            catch {
                child.kill('SIGKILL');
            }
        }
        await waitForExit(child, 500);
    }
}
export class Supervisor {
    private readonly config: SupervisorConfig;
    private phase: SupervisorPhase = 'stopped';
    instanceId = randomUUID();
    private readonly logs: SecretLogBuffer;
    private readonly children = new Map<'dsh' | 'studio', ManagedChildProcess>();
    private runtime: RuntimeState | undefined;
    private startPromise: Promise<StartResult> | undefined;
    private stopPromise: Promise<void> | undefined;
    private startupFailure: SupervisorError | undefined;
    generation = 0;
    ownsLock = false;
    private lastError: SupervisorStatus['lastError'];
    private readonly dependencies: SupervisorDependencies;
    private lockRecord: LockRecord | undefined;
    private cleanupPromise: Promise<void> | undefined;
    statusListeners = new Set<(status: SupervisorStatus) => void>();
    constructor(config: SupervisorConfig, dependencies: Partial<SupervisorDependencies> = {}) {
        this.config = config;
        this.dependencies = {
            reservePort,
            spawn: (spec: ServiceSpec) => spawn(spec.executable, spec.args, {
                cwd: spec.cwd,
                env: spec.env,
                windowsHide: true,
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
            fetch: (input: string, init?: RequestInit) => fetch(input, init),
            killTree: killOwnedTree,
            ...dependencies,
        };
        this.logs = new SecretLogBuffer({
            secrets: [],
            maxCharacters: config.logLimitCharacters ?? 32_768,
        });
    }
    start(): Promise<StartResult> {
        if (this.startPromise)
            return this.startPromise;
        if (this.stopPromise) {
            const stopping = this.stopPromise;
            const queued = stopping.then(() => {
                if (this.stopPromise === stopping)
                    this.stopPromise = undefined;
                if (this.startPromise === queued)
                    this.startPromise = undefined;
                return this.start();
            });
            this.startPromise = queued;
            return queued;
        }
        if (this.phase === 'running' && this.runtime)
            return Promise.resolve({ ...this.runtime });
        const generation = ++this.generation;
        this.phase = 'starting';
        this.emitStatus();
        this.lastError = undefined;
        this.startupFailure = undefined;
        const pending = this.startInternal(generation).catch(async (error) => {
            const safe = this.toSupervisorError(error);
            this.lastError = { code: safe.code, message: safe.message };
            await this.cleanup(generation);
            throw safe;
        }).finally(() => {
            if (this.startPromise === pending)
                this.startPromise = undefined;
        });
        this.startPromise = pending;
        return pending;
    }
    stop(): Promise<void> {
        if (this.stopPromise)
            return this.stopPromise;
        if (this.phase === 'stopped' && this.children.size === 0 && !this.ownsLock && !this.startPromise)
            return Promise.resolve();
        const generation = ++this.generation;
        this.phase = 'stopping';
        this.emitStatus();
        const startup = this.startPromise?.catch(() => undefined) ?? Promise.resolve();
        const pending = startup.then(() => this.cleanup(generation)).finally(() => {
            if (this.stopPromise === pending)
                this.stopPromise = undefined;
        });
        this.stopPromise = pending;
        return pending;
    }
    async restart(): Promise<StartResult> {
        await this.stop();
        return this.start();
    }
    status(): SupervisorStatus {
        const processes: SupervisorStatus['processes'] = {};
        const dshPid = this.children.get('dsh')?.pid;
        const studioPid = this.children.get('studio')?.pid;
        if (dshPid)
            processes.dsh = dshPid;
        if (studioPid)
            processes.studio = studioPid;
        const service = (name: 'dsh' | 'studio', url: string | undefined): ServiceStatus => {
            const pid = this.children.get(name)?.pid;
            return {
                service: name,
                state: this.phase,
                healthy: this.phase === 'running' && pid !== undefined,
                ...(pid ? { pid } : {}),
                ...(url ? { url } : {}),
            };
        };
        return {
            phase: this.phase,
            ...(this.runtime ? { studioUrl: this.runtime.studioUrl, dshUrl: this.runtime.dshUrl } : {}),
            processes,
            services: {
                dsh: service('dsh', this.runtime?.dshUrl),
                studio: service('studio', this.runtime?.studioUrl),
            },
            logs: this.logs.snapshot(),
            ...(this.lastError ? { lastError: { ...this.lastError } } : {}),
        };
    }
    async doctor(): Promise<DoctorResult> {
        const paths = [
            ['node', this.config.nodeExecutable],
            ['dsh', this.config.dshBin],
            ['gateway', this.config.gatewayEntry],
            ['home', this.config.dshHome],
        ] as const;
        const entries = await Promise.all(paths.map(async ([component, path]): Promise<DoctorEntry> => {
            const exists = await fileExists(path);
            let version: string | undefined;
            if (component === 'node' && exists)
                version = await nodeVersion(this.config.nodeExecutable);
            if (component === 'dsh' && exists)
                version = await this.readDshVersion();
            return {
                component,
                path: this.logs.sanitize(path),
                exists,
                ...(version ? { version: this.logs.sanitize(version) } : {}),
                status: !exists ? 'missing' : component === 'node' && !version ? 'unhealthy' : 'ready',
            };
        }));
        const running = this.phase === 'running';
        const [dshHealthy, studioHealthy] = running
            ? await Promise.all([this.probeDsh(), this.probeStudio()])
            : [false, false];
        return {
            phase: this.phase,
            entries,
            services: {
                dsh: !running ? 'not-running' : dshHealthy ? 'ready' : 'unhealthy',
                studio: !running ? 'not-running' : studioHealthy ? 'ready' : 'unhealthy',
            },
        };
    }
    async startInternal(generation: number): Promise<StartResult> {
        this.validateConfig();
        await this.validatePaths();
        this.assertCurrent(generation);
        await this.acquireLock();
        this.assertCurrent(generation);
        let dshPort: number;
        let studioPort: number;
        try {
            dshPort = await this.dependencies.reservePort(this.config.dshPort);
            studioPort = await this.dependencies.reservePort(this.config.studioPort);
        }
        catch {
            throw new SupervisorError('port-occupied', 'A configured loopback port is already occupied.');
        }
        if (dshPort === studioPort) {
            if (this.config.dshPort !== 0 && this.config.studioPort !== 0) {
                throw new SupervisorError('invalid-config', 'DSH and Studio ports must differ.');
            }
            studioPort = await this.dependencies.reservePort(0);
        }
        this.assertCurrent(generation);
        const dsh = this.spawnOwned('dsh', [
            this.config.dshBin,
            '--profile', 'web',
            '--host', HOST,
            '--port', String(dshPort),
            '--no-open',
        ], {
            ...process.env,
            DSH_HOME: this.config.dshHome,
        }, generation);
        const launchUrl = await this.waitForDshLaunch(dsh, generation);
        const parsed = new URL(launchUrl);
        if (parsed.protocol !== 'http:' || parsed.hostname !== HOST || Number(parsed.port) !== dshPort) {
            throw new SupervisorError('child-exited', 'DSH reported an unexpected launch address.');
        }
        const token = parsed.searchParams.get('token');
        if (!token)
            throw new SupervisorError('child-exited', 'DSH did not provide its process credential.');
        this.logs.addSecret(token);
        const dshUrl = `${parsed.protocol}//${parsed.host}`;
        this.runtime = { dshUrl, studioUrl: `http://${HOST}:${studioPort}`, launchUrl };
        await this.waitForHealth(() => this.probeDsh(), 'DSH', generation);
        const studio = this.spawnOwned('studio', [
            '--conditions=dsh-rp-production',
            this.config.gatewayEntry,
        ], {
            ...process.env,
            DSH_HOME: this.config.dshHome,
            DSH_BASE_URL: dshUrl,
            PROMPT_PRESETS_BASE_URL: `${dshUrl}/prompt-presets/api`,
            DSH_WEB_TOKEN: token,
            PROMPT_PRESETS_WEB_TOKEN: token,
            DSH_RP_HOST: HOST,
            DSH_RP_PORT: String(studioPort),
        }, generation);
        await this.waitForHealth(() => this.probeStudio(), 'Studio', generation);
        this.assertChildAlive(studio, 'Studio');
        this.assertCurrent(generation);
        this.phase = 'running';
        this.emitStatus();
        return { ...this.runtime };
    }
    validateConfig() {
        if (!validPort(this.config.dshPort) || !validPort(this.config.studioPort)) {
            throw new SupervisorError('invalid-config', 'Ports must be integers from 0 through 65535.');
        }
        if (this.config.dshPort !== 0 && this.config.dshPort === this.config.studioPort) {
            throw new SupervisorError('invalid-config', 'DSH and Studio ports must differ.');
        }
        if ((this.config.startupTimeoutMs ?? 30_000) <= 0) {
            throw new SupervisorError('invalid-config', 'Startup timeout must be positive.');
        }
    }
    async validatePaths() {
        const missing = [];
        for (const path of [this.config.nodeExecutable, this.config.dshBin, this.config.gatewayEntry, this.config.cwd]) {
            if (!await fileExists(path))
                missing.push(basename(path));
        }
        if (missing.length > 0)
            throw new SupervisorError('missing-path', `Required runtime paths are missing: ${missing.join(', ')}`);
    }
    async acquireLock() {
        await mkdir(this.config.dshHome, { recursive: true });
        const path = join(this.config.dshHome, LOCK_NAME);
        const identity = await processIdentity(process.pid);
        const record: LockRecord = { owner: this.instanceId, pid: process.pid, ...(identity ? { identity } : {}) };
        for (;;) {
            try {
                const handle = await open(path, 'wx');
                try {
                    await handle.writeFile(JSON.stringify(record));
                }
                finally {
                    await handle.close();
                }
                this.lockRecord = record;
                this.ownsLock = true;
                return;
            }
            catch (error) {
                const code = error instanceof Error && 'code' in error ? String(error.code) : '';
                if (code !== 'EEXIST')
                    throw error;
                let existing: LockRecord;
                try {
                    existing = JSON.parse(await readFile(path, 'utf8')) as LockRecord;
                }
                catch {
                    throw new SupervisorError('home-locked', 'This DSH home is already supervised by another instance.');
                }
                if (!existing || typeof existing.owner !== 'string' || !Number.isInteger(existing.pid))
                    throw new SupervisorError('home-locked', 'This DSH home is already supervised by another instance.');
                const liveIdentity = await processIdentity(existing.pid);
                const stale = liveIdentity === undefined || (existing.identity !== undefined && liveIdentity !== existing.identity);
                if (!stale)
                    throw new SupervisorError('home-locked', 'This DSH home is already supervised by another instance.');
                try {
                    const current = JSON.parse(await readFile(path, 'utf8')) as LockRecord;
                    if (current.owner !== existing.owner || current.pid !== existing.pid || current.identity !== existing.identity)
                        continue;
                    await unlink(path);
                }
                catch {
                    throw new SupervisorError('home-locked', 'This DSH home is already supervised by another instance.');
                }
            }
        }
    }
    spawnOwned(kind: 'dsh' | 'studio', args: string[], env: NodeJS.ProcessEnv, generation: number): ManagedChildProcess {
        let child: ManagedChildProcess;
        try {
            child = this.dependencies.spawn({
                service: kind,
                executable: this.config.nodeExecutable,
                args,
                cwd: this.config.cwd,
                env,
                port: Number(kind === 'dsh' ? args[args.indexOf('--port') + 1] : env.DSH_RP_PORT),
            });
        }
        catch {
            throw new SupervisorError('spawn-error', `Unable to spawn ${kind}.`);
        }
        this.children.set(kind, child);
        child.stdout?.on('data', chunk => this.logs.push(kind, chunk, 'stdout'));
        child.stderr?.on('data', chunk => this.logs.push(kind, chunk, 'stderr'));
        child.once('error', () => {
            this.recordChildFailure(kind, new SupervisorError('spawn-error', `Unable to spawn ${kind}.`), generation);
        });
        child.once('exit', (code, signal) => {
            this.logs.end(kind);
            if (this.children.get(kind) === child)
                this.children.delete(kind);
            if (this.phase === 'stopping' || generation !== this.generation)
                return;
            const suffix = signal ? ` by signal ${signal}` : ` with code ${code ?? 'unknown'}`;
            this.recordChildFailure(kind, new SupervisorError('child-exited', `${kind} exited${suffix}.`), generation);
        });
        return child;
    }
    recordChildFailure(_kind: 'dsh' | 'studio', error: SupervisorError, generation: number): void {
        if (generation !== this.generation)
            return;
        const safe = new SupervisorError(error.code, this.logs.sanitize(error.message));
        this.lastError = { code: safe.code, message: safe.message };
        this.emitStatus();
        if (this.phase === 'starting')
            this.startupFailure = safe;
        if (this.phase === 'running') {
            this.phase = 'stopping';
            const cleanupGeneration = ++this.generation;
            const pending = this.cleanup(cleanupGeneration).finally(() => {
                if (this.stopPromise === pending)
                    this.stopPromise = undefined;
            });
            this.stopPromise = pending;
        }
    }
    waitForDshLaunch(child: ManagedChildProcess, generation: number): Promise<string> {
        const timeoutMs = this.config.startupTimeoutMs ?? 30_000;
        return new Promise<string>((resolve, reject) => {
            let output = '';
            let settled = false;
            let candidateTimer: ReturnType<typeof setTimeout> | undefined;
            const finish = (error?: unknown, value?: string): void => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                if (candidateTimer)
                    clearTimeout(candidateTimer);
                child.stdout?.off('data', read);
                child.off('error', onError);
                child.off('exit', onExit);
                if (error)
                    reject(error);
                else
                    resolve(value ?? '');
            };
            const parse = (): void => {
                const clean = stripAnsi(output);
                if (!output.endsWith('\n'))
                    return;
                const match = /https?:\/\/127\.0\.0\.1:\d+\/\?token=([^\s]+)/u.exec(clean);
                if (match?.[0] && match[1]) {
                    this.logs.addSecret(match[1]);
                    finish(undefined, match[0]);
                }
            };
            const read = (chunk: Buffer | string): void => {
                output = `${output}${chunk.toString('utf8')}`.slice(-65_536);
                if (candidateTimer)
                    clearTimeout(candidateTimer);
                if (output.includes('\n'))
                    parse();
                else
                    candidateTimer = setTimeout(parse, 20);
            };
            const onError = (_error: Error): void => finish(new SupervisorError('spawn-error', 'Unable to spawn DSH.'));
            const onExit = (code: number | null): void => finish(new SupervisorError('child-exited', `DSH exited before readiness with code ${code ?? 'unknown'}.`));
            const timer = setTimeout(() => finish(new SupervisorError('startup-timeout', 'DSH startup timed out.')), timeoutMs);
            child.stdout?.on('data', read);
            child.once('error', onError);
            child.once('exit', onExit);
            try {
                this.assertCurrent(generation);
            }
            catch (error) {
                finish(error);
            }
        });
    }
    async waitForHealth(probe: () => Promise<boolean>, name: string, generation: number): Promise<void> {
        const deadline = Date.now() + (this.config.startupTimeoutMs ?? 30_000);
        while (Date.now() < deadline) {
            this.assertCurrent(generation);
            if (this.startupFailure)
                throw this.startupFailure;
            if (await probe())
                return;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new SupervisorError('startup-timeout', `${name} identity health check timed out.`);
    }
    async probeDsh(): Promise<boolean> {
        const runtime = this.runtime;
        const child = this.children.get('dsh');
        if (!runtime || !child || child.exitCode !== null)
            return false;
        try {
            const response = await this.dependencies.fetch(runtime.launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(500) });
            if (response.status < 300 || response.status >= 400)
                return false;
            const location = response.headers.get('location');
            const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
            if (!location || !cookie)
                return false;
            const redirected = await this.dependencies.fetch(new URL(location, runtime.launchUrl).toString(), {
                headers: { cookie },
                signal: AbortSignal.timeout(500),
            });
            const body = await redirected.text();
            return redirected.ok && /(?:deepseek\s+harness|\bdsh\b)/iu.test(body);
        }
        catch {
            return false;
        }
    }
    async probeStudio(): Promise<boolean> {
        const runtime = this.runtime;
        const child = this.children.get('studio');
        if (!runtime || !child || child.exitCode !== null)
            return false;
        try {
            const response = await this.dependencies.fetch(`${runtime.studioUrl}/api/v1/health`, { signal: AbortSignal.timeout(500) });
            if (!response.ok)
                return false;
            const value = await response.json();
            if (!value || typeof value !== 'object')
                return false;
            const envelope = value as Record<string, unknown>;
            const data = envelope.data;
            return envelope.ok === true
                && envelope.protocolVersion === 1
                && !!data
                && typeof data === 'object'
                && (data as Record<string, unknown>).upstream === 'ready';
        }
        catch {
            return false;
        }
    }
    assertChildAlive(child: ManagedChildProcess, name: string): void {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new SupervisorError('child-exited', `${name} exited before readiness.`);
        }
    }
    assertCurrent(generation: number): void {
        if (generation !== this.generation || this.phase === 'stopping') {
            throw new SupervisorError('startup-cancelled', 'Startup was cancelled.');
        }
    }
    async cleanup(_generation: number): Promise<void> {
        this.phase = 'stopping';
        this.emitStatus();
        const owned = [...this.children.values()];
        this.children.clear();
        await Promise.all(owned.map(child => this.dependencies.killTree(child)));
        this.logs.end('dsh');
        this.logs.end('studio');
        this.runtime = undefined;
        await this.releaseLock();
        this.phase = 'stopped';
        this.emitStatus();
    }
    onStatus(listener: (status: SupervisorStatus) => void): () => void {
        this.statusListeners.add(listener);
        listener(this.status());
        return () => { this.statusListeners.delete(listener); };
    }
    emitStatus(): void {
        const snapshot = this.status();
        for (const listener of this.statusListeners) {
            try { listener(snapshot); }
            catch { /* A UI listener cannot break process supervision. */ }
        }
    }
    async releaseLock(): Promise<void> {
        if (!this.ownsLock)
            return;
        this.ownsLock = false;
        const path = join(this.config.dshHome, LOCK_NAME);
        try {
            const content = JSON.parse(await readFile(path, 'utf8'));
            if (content.owner === this.instanceId)
                await unlink(path);
        }
        catch {
            // The lock is best-effort on teardown; never remove a replacement lock.
        }
    }
    async readDshVersion(): Promise<string | undefined> {
        try {
            const manifestPath = join(dirname(dirname(this.config.dshBin)), 'package.json');
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
            return manifest.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string'
                ? manifest.version
                : undefined;
        }
        catch {
            return undefined;
        }
    }
    toSupervisorError(error: unknown): SupervisorError {
        if (error instanceof SupervisorError) {
            return new SupervisorError(error.code, this.logs.sanitize(error.message));
        }
        return new SupervisorError('spawn-error', this.logs.sanitize(errorText(error)));
    }
}
export { SecretLogBuffer };
export function createSupervisor(config: SupervisorConfig): Supervisor {
    return new Supervisor(config)
}
