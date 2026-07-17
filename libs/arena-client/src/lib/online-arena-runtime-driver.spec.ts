import { describe, expect, it, vi } from 'vitest';

import {
  createLazyOnlineArenaRuntimeDriverFactory,
  type OnlineArenaRuntimeDriver,
  type OnlineArenaRuntimeDriverOptions,
} from './online-arena-runtime-driver';

describe('online arena runtime driver factory', () => {
  it('does not load online runtime code until the factory is explicitly invoked', async () => {
    const driver = createDriverStub();
    const createOnlineArenaRuntimeDriver = vi.fn<
      (options: OnlineArenaRuntimeDriverOptions) => OnlineArenaRuntimeDriver
    >(() => driver);
    const loadRuntime = vi.fn<
      () => Promise<{
        createOnlineArenaRuntimeDriver: typeof createOnlineArenaRuntimeDriver;
      }>
    >(async () => ({ createOnlineArenaRuntimeDriver }));
    const factory = createLazyOnlineArenaRuntimeDriverFactory(loadRuntime);

    expect(loadRuntime).not.toHaveBeenCalled();
    const options = createOptions();
    await expect(factory(options)).resolves.toBe(driver);
    expect(loadRuntime).toHaveBeenCalledOnce();
    expect(createOnlineArenaRuntimeDriver).toHaveBeenCalledWith(options);
  });
});

function createOptions(): OnlineArenaRuntimeDriverOptions {
  return {
    config: {
      authorityUrl: 'https://authority.example',
      buildId: 'build-1',
      enabled: true,
    },
    host: document.createElement('div'),
    onFieldMenuRequested: vi.fn<() => void>(),
    onHudSnapshot: vi.fn<OnlineArenaRuntimeDriverOptions['onHudSnapshot']>(),
    onInputReset: vi.fn<OnlineArenaRuntimeDriverOptions['onInputReset']>(),
    onReconnectGraceChanged:
      vi.fn<OnlineArenaRuntimeDriverOptions['onReconnectGraceChanged']>(),
    onStatus: vi.fn<OnlineArenaRuntimeDriverOptions['onStatus']>(),
    onUnavailable: vi.fn<OnlineArenaRuntimeDriverOptions['onUnavailable']>(),
    reducedMotion: false,
  };
}

function createDriverStub(): OnlineArenaRuntimeDriver {
  return {
    closeFieldMenu: vi.fn<OnlineArenaRuntimeDriver['closeFieldMenu']>(),
    dispose: vi.fn<OnlineArenaRuntimeDriver['dispose']>(),
    leave: vi.fn<OnlineArenaRuntimeDriver['leave']>(async () => undefined),
    openFieldMenu: vi.fn<OnlineArenaRuntimeDriver['openFieldMenu']>(),
    resumeSession: vi.fn<OnlineArenaRuntimeDriver['resumeSession']>(
      async () => undefined,
    ),
    setReducedMotion: vi.fn<OnlineArenaRuntimeDriver['setReducedMotion']>(),
    setTouchAim: vi.fn<OnlineArenaRuntimeDriver['setTouchAim']>(),
    setTouchMove: vi.fn<OnlineArenaRuntimeDriver['setTouchMove']>(),
    startFreshQuickplay: vi.fn<OnlineArenaRuntimeDriver['startFreshQuickplay']>(
      async () => undefined,
    ),
    startQuickplay: vi.fn<OnlineArenaRuntimeDriver['startQuickplay']>(
      async () => undefined,
    ),
    triggerDash: vi.fn<OnlineArenaRuntimeDriver['triggerDash']>(),
  };
}
