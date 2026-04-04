'use strict';

const path = require('path');

function isSafeFilePath(userPath) {
  if (typeof userPath !== 'string') return false;
  const rawPath = userPath.trim();
  if (!rawPath || rawPath.includes('\0')) return false;
  return path.isAbsolute(rawPath);
}

function shouldUseStrictTls({ nodeEnv = '', isPackaged = false } = {}) {
  return isPackaged || String(nodeEnv).toLowerCase() === 'production';
}

function createRateLimiter(now = () => Date.now()) {
  const buckets = new Map();

  function consume(key, { limit, windowMs }) {
    const currentTime = now();
    const cutoff = currentTime - windowMs;
    const timestamps = (buckets.get(key) || []).filter(ts => ts > cutoff);

    if (timestamps.length >= limit) {
      return {
        ok: false,
        retryAfterMs: Math.max(0, windowMs - (currentTime - timestamps[0]))
      };
    }

    timestamps.push(currentTime);
    buckets.set(key, timestamps);
    return {
      ok: true,
      remaining: Math.max(0, limit - timestamps.length)
    };
  }

  return { consume };
}

function getRateLimitKey(channel, event) {
  const senderId = event?.sender?.id ?? 'unknown';
  const frameUrl = event?.senderFrame?.url ?? 'unknown';
  return `${channel}:${senderId}:${frameUrl}`;
}

module.exports = {
  createRateLimiter,
  getRateLimitKey,
  isSafeFilePath,
  shouldUseStrictTls
};