import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ArenaGame,
  type ArenaRuntimeDriver,
  type ArenaRuntimeDriverFactory,
  type OnlineArenaRuntimeDriverFactory,
} from '@dropzone-arena/arena-client';

describe('local entry isolation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not fetch or invoke the lazy online runtime while rendering and starting local play', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn<typeof globalThis.fetch>();
    const start = vi.fn<(seed: number) => void>();
    const runtime: ArenaRuntimeDriver = {
      dispose: vi.fn<ArenaRuntimeDriver['dispose']>(),
      pause: vi.fn<ArenaRuntimeDriver['pause']>(),
      resume: vi.fn<ArenaRuntimeDriver['resume']>(),
      setReducedMotion: vi.fn<ArenaRuntimeDriver['setReducedMotion']>(),
      setTouchAim: vi.fn<ArenaRuntimeDriver['setTouchAim']>(),
      setTouchMove: vi.fn<ArenaRuntimeDriver['setTouchMove']>(),
      start,
      triggerDash: vi.fn<ArenaRuntimeDriver['triggerDash']>(),
    };
    const runtimeFactory = vi.fn<ArenaRuntimeDriverFactory>(() => runtime);
    const lazyOnlineRuntimeFactory = vi.fn<OnlineArenaRuntimeDriverFactory>();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('matchMedia', () => ({
      addEventListener() {},
      matches: false,
      removeEventListener() {},
    }));

    render(
      <ArenaGame
        online={{
          authorityUrl: 'https://arena.example.test',
          buildId: 'local-development',
          enabled: true,
        }}
        onlineRuntimeFactory={lazyOnlineRuntimeFactory}
        runtimeFactory={runtimeFactory}
      />,
    );

    const dropIn = await screen.findByRole('button', { name: 'Drop in' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lazyOnlineRuntimeFactory).not.toHaveBeenCalled();

    await user.click(dropIn);

    expect(start).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lazyOnlineRuntimeFactory).not.toHaveBeenCalled();
  });
});
