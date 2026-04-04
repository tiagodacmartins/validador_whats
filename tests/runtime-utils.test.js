'use strict';

const { createRateLimiter, isSafeFilePath, shouldUseStrictTls } = require('../lib/runtime-utils');

describe('runtime-utils', () => {
  test('isSafeFilePath aceita apenas caminhos absolutos', () => {
    expect(isSafeFilePath('C:\\temp\\arquivo.txt')).toBe(true);
    expect(isSafeFilePath('.\\arquivo.txt')).toBe(false);
    expect(isSafeFilePath('..\\segredo.txt')).toBe(false);
    expect(isSafeFilePath('')).toBe(false);
  });

  test('shouldUseStrictTls ativa modo estrito em producao ou app empacotado', () => {
    expect(shouldUseStrictTls({ nodeEnv: 'production', isPackaged: false })).toBe(true);
    expect(shouldUseStrictTls({ nodeEnv: 'development', isPackaged: true })).toBe(true);
    expect(shouldUseStrictTls({ nodeEnv: 'development', isPackaged: false })).toBe(false);
  });

  test('createRateLimiter bloqueia excesso dentro da janela', () => {
    let currentTime = 1000;
    const limiter = createRateLimiter(() => currentTime);

    expect(limiter.consume('search-cache:1', { limit: 2, windowMs: 5000 })).toMatchObject({ ok: true });
    expect(limiter.consume('search-cache:1', { limit: 2, windowMs: 5000 })).toMatchObject({ ok: true });

    const blocked = limiter.consume('search-cache:1', { limit: 2, windowMs: 5000 });
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    currentTime += 5001;
    expect(limiter.consume('search-cache:1', { limit: 2, windowMs: 5000 })).toMatchObject({ ok: true });
  });
});