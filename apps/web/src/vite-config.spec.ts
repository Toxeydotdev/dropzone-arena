import { describe, expect, it } from 'vitest';

import { resolveOnlineAuthorityProxyTarget } from '../vite.config';

describe('resolveOnlineAuthorityProxyTarget', () => {
  it('defaults to the local authority origin', () => {
    expect(resolveOnlineAuthorityProxyTarget(undefined)).toBe('http://localhost:4302');
  });

  it('normalizes a valid private proxy target to its origin', () => {
    expect(resolveOnlineAuthorityProxyTarget('https://authority.example.test/')).toBe(
      'https://authority.example.test',
    );
  });

  it.each([
    'not a URL',
    'ftp://localhost:4302',
    'http://user:secret@localhost:4302',
    'http://localhost:4302/api',
    'http://localhost:4302/?region=local',
    'http://localhost:4302/#status',
  ])('rejects invalid private proxy target %j', (target) => {
    expect(() => resolveOnlineAuthorityProxyTarget(target)).toThrow(
      'ONLINE_AUTHORITY_PROXY_TARGET',
    );
  });
});
