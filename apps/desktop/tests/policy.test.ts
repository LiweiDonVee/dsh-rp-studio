import { describe, expect, it } from 'vitest';
import {
  isAllowedNavigation,
  isAllowedWindowOpen,
  shouldBlockDownload,
  shouldBlockProtocol,
  shouldRevokeStudioTrust,
} from '../src/main/policy.js';

describe('desktop navigation policy', () => {
  it('allows only the configured loopback Studio URL', () => {
    expect(isAllowedNavigation('http://127.0.0.1:49123/', 'http://127.0.0.1:49123/')).toBe(true);
    expect(isAllowedNavigation('http://localhost:4317/settings')).toBe(false);
    expect(isAllowedNavigation('https://example.com/')).toBe(false);
  });

  it('rejects arbitrary loopback origins before an owned Studio start', () => {
    expect(isAllowedNavigation('http://127.0.0.1:49123/')).toBe(false);
  });

  it('allows only the exact locally bundled settings page when configured', () => {
    const page = 'file:///C:/app/src/renderer/index.html';
    expect(isAllowedNavigation(page, 'http://127.0.0.1:4317/', page)).toBe(true);
    expect(isAllowedNavigation('file:///C:/app/src/renderer/other.html', 'http://127.0.0.1:4317/', page)).toBe(false);
    expect(isAllowedNavigation('http://127.0.0.1/', page, page)).toBe(false);
  });

  it('blocks window opens, downloads, and unsafe protocols', () => {
    expect(isAllowedWindowOpen('http://127.0.0.1:4317/popup')).toBe(false);
    expect(shouldBlockDownload()).toBe(true);
    expect(shouldBlockProtocol('file:///secret')).toBe(true);
    expect(shouldBlockProtocol('https://example.com')).toBe(true);
  });

  it('revokes Studio trust whenever Supervisor is no longer running', () => {
    expect(shouldRevokeStudioTrust({ state: 'running' })).toBe(false);
    expect(shouldRevokeStudioTrust({ state: 'running', lastError: { code: 'child-exited' } })).toBe(true);
    expect(shouldRevokeStudioTrust({ state: 'stopped' })).toBe(true);
    expect(shouldRevokeStudioTrust({ state: 'error' })).toBe(true);
  });
});
