import { describe, expect, it } from 'vitest';
import { isTrustedIpcSender } from '../src/main/ipc-trust.js';

describe('IPC sender policy', () => {
  const contents = {};

  it('accepts only the main frame at the configured Studio origin', () => {
    expect(isTrustedIpcSender({ sender: contents, frameId: 0, senderFrame: { url: 'http://127.0.0.1:49123/settings' } }, contents, 'http://127.0.0.1:49123')).toBe(true);
    expect(isTrustedIpcSender({ sender: contents, frameId: 2, senderFrame: { url: 'http://127.0.0.1:4317/' } }, contents, 'http://127.0.0.1:4317')).toBe(false);
    expect(isTrustedIpcSender({ sender: {}, frameId: 0, senderFrame: { url: 'http://127.0.0.1:4317/' } }, contents, 'http://127.0.0.1:4317')).toBe(false);
    expect(isTrustedIpcSender({ sender: contents, frameId: 0, senderFrame: { url: 'https://example.com/' } }, contents, 'http://127.0.0.1:4317')).toBe(false);
  });

  it('uses the Electron main frame identity instead of assuming frame id zero', () => {
    const mainFrame = { url: 'file:///C:/app/renderer/index.html' };
    const webContents = { mainFrame };
    expect(isTrustedIpcSender({ sender: webContents, frameId: 17, senderFrame: mainFrame }, webContents, undefined, mainFrame.url)).toBe(true);
    expect(isTrustedIpcSender({ sender: webContents, frameId: 0, senderFrame: { url: mainFrame.url } }, webContents, undefined, mainFrame.url)).toBe(false);
  });

  it('does not trust an arbitrary loopback origin before Supervisor health succeeds', () => {
    expect(isTrustedIpcSender({ sender: contents, frameId: 0, senderFrame: { url: 'http://127.0.0.1:49123/' } }, contents, undefined)).toBe(false);
  });

  it('accepts an exact bundled desktop page but not another file URL', () => {
    const desktopPage = 'file:///C:/app/renderer/index.html';
    expect(isTrustedIpcSender({ sender: contents, frameId: 0, senderFrame: { url: desktopPage } }, contents, 'http://127.0.0.1:4317', desktopPage)).toBe(true);
    expect(isTrustedIpcSender({ sender: contents, frameId: 0, senderFrame: { url: 'file:///C:/secret.html' } }, contents, 'http://127.0.0.1:4317', desktopPage)).toBe(false);
    expect(isTrustedIpcSender({ sender: contents, frameId: 0, senderFrame: { url: 'file:///C:/secret.html' } }, contents, desktopPage, desktopPage)).toBe(false);
  });
});
