import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArenaGameProps } from '@dropzone-arena/arena-client';

import { App } from './app';

const arenaGame = vi.hoisted(() => vi.fn<(props: ArenaGameProps) => void>());

vi.mock('@dropzone-arena/arena-client', () => ({
  ArenaGame: (props: ArenaGameProps) => {
    arenaGame(props);
    return <main aria-label="Dropzone game surface" />;
  },
}));

describe('App', () => {
  beforeEach(() => arenaGame.mockClear());

  afterEach(() => vi.unstubAllEnvs());

  it('mounts the shared arena surface', () => {
    render(<App />);
    expect(screen.getByRole('main', { name: 'Dropzone game surface' })).not.toBeNull();
  });

  it('passes parsed public online configuration to the arena client', () => {
    vi.stubEnv('VITE_ONLINE_ENABLED', 'true');
    vi.stubEnv('VITE_ONLINE_AUTHORITY_URL', 'https://arena.example.test');
    vi.stubEnv('VITE_BUILD_ID', 'web-build_123');

    render(<App />);

    const props = arenaGame.mock.calls.at(-1)?.[0] as ArenaGameProps | undefined;
    expect(props?.online).toEqual({
      authorityUrl: 'https://arena.example.test',
      buildId: 'web-build_123',
      enabled: true,
    });
  });
});
