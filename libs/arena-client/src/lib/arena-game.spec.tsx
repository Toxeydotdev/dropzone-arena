import { StrictMode } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Vector2 } from '@dropzone-arena/arena-engine';

import { ArenaGame } from './arena-game';
import type {
  ArenaHudSnapshot,
  ArenaRuntimeDriver,
  ArenaRuntimeDriverOptions,
} from './arena-runtime-driver';
import type {
  EnabledOnlineArenaConfig,
  OnlineArenaHudSnapshot,
  OnlineArenaRuntimeDriver,
  OnlineArenaRuntimeDriverFactory,
  OnlineArenaRuntimeDriverOptions,
  OnlineArenaStatus,
  OnlineArenaUnavailableReason,
} from './online-arena-runtime-driver';

const PLAYING_SNAPSHOT: ArenaHudSnapshot = {
  combo: 3,
  dashReady: 0.5,
  enemyCount: 6,
  health: 72,
  overdriveTime: 0,
  score: 1_250,
  stats: { damageTaken: 28, eliminations: 8, hits: 12, shots: 20 },
  status: 'playing',
  timeRemaining: 64,
  wave: 2,
};

const ONLINE_CONFIG: EnabledOnlineArenaConfig = {
  authorityUrl: 'https://authority.example',
  buildId: 'build-1',
  enabled: true,
};

const ONLINE_HUD: OnlineArenaHudSnapshot = {
  callsign: 'ALPHA',
  dashReady: 0.5,
  deaths: 2,
  health: 72,
  kills: 4,
  marker: 3,
  population: 2,
  respawnSeconds: 0,
  roster: [
    {
      callsign: 'BRAVO',
      deaths: 1,
      kills: 2,
      marker: 1,
      status: 'alive',
      you: false,
    },
    {
      callsign: 'ALPHA',
      deaths: 2,
      kills: 4,
      marker: 3,
      status: 'alive',
      you: true,
    },
  ],
  status: 'alive',
};

class FakeRuntime implements ArenaRuntimeDriver {
  options: ArenaRuntimeDriverOptions | null = null;
  disposeCount = 0;
  pauseCount = 0;
  resumeCount = 0;
  starts: number[] = [];
  dashCount = 0;
  reducedMotionValues: boolean[] = [];
  touchAim: Array<{ direction: Vector2; firing: boolean }> = [];
  touchMove: Vector2[] = [];

  factory = (options: ArenaRuntimeDriverOptions): ArenaRuntimeDriver => {
    this.options = options;
    return this;
  };

  dispose(): void {
    this.disposeCount += 1;
  }

  pause(): void {
    this.pauseCount += 1;
  }

  resume(): void {
    this.resumeCount += 1;
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotionValues.push(reducedMotion);
  }

  setTouchAim(direction: Vector2, firing: boolean): void {
    this.touchAim.push({ direction, firing });
  }

  setTouchMove(direction: Vector2): void {
    this.touchMove.push(direction);
  }

  start(seed: number): void {
    this.starts.push(seed);
  }

  triggerDash(): void {
    this.dashCount += 1;
  }
}

class LocalFactoryHarness {
  readonly drivers: FakeRuntime[] = [];

  readonly factory = (options: ArenaRuntimeDriverOptions): ArenaRuntimeDriver => {
    const driver = new FakeRuntime();
    driver.options = options;
    this.drivers.push(driver);
    return driver;
  };
}

class FakeOnlineRuntime implements OnlineArenaRuntimeDriver {
  closeFieldMenuCount = 0;
  disposeCount = 0;
  leaveCount = 0;
  openFieldMenuCount = 0;
  resumeSessionCount = 0;
  startFreshQuickplayCount = 0;
  startQuickplayCount = 0;
  dashCount = 0;
  reducedMotionValues: boolean[] = [];
  touchAim: Array<{ direction: Vector2; firing: boolean }> = [];
  touchMove: Vector2[] = [];

  constructor(readonly options: OnlineArenaRuntimeDriverOptions) {}

  closeFieldMenu(): void {
    this.closeFieldMenuCount += 1;
  }

  dispose(): void {
    this.disposeCount += 1;
  }

  async leave(): Promise<void> {
    this.leaveCount += 1;
  }

  openFieldMenu(): void {
    this.openFieldMenuCount += 1;
  }

  async resumeSession(): Promise<void> {
    this.resumeSessionCount += 1;
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotionValues.push(reducedMotion);
  }

  setTouchAim(direction: Vector2, firing: boolean): void {
    this.touchAim.push({ direction, firing });
  }

  setTouchMove(direction: Vector2): void {
    this.touchMove.push(direction);
  }

  async startFreshQuickplay(): Promise<void> {
    this.startFreshQuickplayCount += 1;
  }

  async startQuickplay(): Promise<void> {
    this.startQuickplayCount += 1;
  }

  triggerDash(): void {
    this.dashCount += 1;
  }

  emitHud(snapshot: OnlineArenaHudSnapshot): void {
    this.options.onHudSnapshot(snapshot);
  }

  emitInputReset(): void {
    this.options.onInputReset();
  }

  emitReconnectGrace(remainingSeconds: number | null): void {
    this.options.onReconnectGraceChanged(remainingSeconds);
  }

  emitStatus(status: OnlineArenaStatus): void {
    this.options.onStatus(status);
  }

  emitUnavailable(reason: OnlineArenaUnavailableReason): void {
    this.options.onUnavailable(reason);
  }
}

class OnlineFactoryHarness {
  readonly drivers: FakeOnlineRuntime[] = [];

  readonly factory: OnlineArenaRuntimeDriverFactory = (options) => {
    const driver = new FakeOnlineRuntime(options);
    this.drivers.push(driver);
    return driver;
  };
}

async function enterOnline(
  local = new LocalFactoryHarness(),
  online = new OnlineFactoryHarness(),
) {
  const user = userEvent.setup();
  render(
    <ArenaGame
      online={ONLINE_CONFIG}
      onlineRuntimeFactory={online.factory}
      runtimeFactory={local.factory}
    />,
  );
  await user.click(await screen.findByRole('button', { name: 'Public quickplay' }));
  await waitFor(() => expect(online.drivers).toHaveLength(1));
  const driver = online.drivers[0];
  if (!driver) throw new Error('Expected online runtime');
  return { driver, local, online, user };
}

function connectOnline(
  driver: FakeOnlineRuntime,
  snapshot: OnlineArenaHudSnapshot = ONLINE_HUD,
): void {
  act(() => {
    driver.emitStatus('connected');
    driver.emitHud(snapshot);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ArenaGame', () => {
  it('moves from immediate entry into a live semantic HUD', async () => {
    const user = userEvent.setup();
    const runtime = new FakeRuntime();
    render(<ArenaGame runtimeFactory={runtime.factory} />);

    await user.click(await screen.findByRole('button', { name: 'Drop in' }));
    expect(runtime.starts).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Run status' })).not.toBeNull();

    act(() => runtime.options?.onSnapshot(PLAYING_SNAPSHOT));
    expect(screen.getByLabelText('01:04 remaining')).not.toBeNull();
    expect(screen.getByText('001250')).not.toBeNull();
    expect(screen.getByText('6 contacts')).not.toBeNull();
    expect(
      (
        screen.getByRole('progressbar', {
          name: 'Suit integrity',
        }) as HTMLProgressElement
      ).value,
    ).toBe(72);
  });

  it('pauses and resumes the same runtime', async () => {
    const user = userEvent.setup();
    const runtime = new FakeRuntime();
    render(<ArenaGame runtimeFactory={runtime.factory} />);
    await user.click(await screen.findByRole('button', { name: 'Drop in' }));

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(runtime.pauseCount).toBe(1);
    expect(screen.getByRole('heading', { name: 'Run paused' })).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Resume run' }));
    expect(runtime.resumeCount).toBe(1);
    expect(screen.queryByRole('heading', { name: 'Run paused' })).toBeNull();
  });

  it('reports the terminal run and starts a fresh drop', async () => {
    const user = userEvent.setup();
    const runtime = new FakeRuntime();
    render(<ArenaGame runtimeFactory={runtime.factory} />);
    await user.click(await screen.findByRole('button', { name: 'Drop in' }));

    act(() =>
      runtime.options?.onRunEnded({
        ...PLAYING_SNAPSHOT,
        health: 44,
        score: 4_800,
        status: 'extracted',
        timeRemaining: 0,
      }),
    );

    expect(screen.getByRole('heading', { name: 'Extraction complete' })).not.toBeNull();
    expect(screen.getByText('4,800')).not.toBeNull();
    expect(screen.getByText('60%')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Drop again' }));
    expect(runtime.starts).toHaveLength(2);
  });

  it('shows a recoverable state when runtime construction fails', async () => {
    const user = userEvent.setup();
    const runtime = new FakeRuntime();
    const factory = vi
      .fn<
        (
          options: ArenaRuntimeDriverOptions,
        ) => ArenaRuntimeDriver | Promise<ArenaRuntimeDriver>
      >()
      .mockRejectedValueOnce(new Error('WebGL unavailable'))
      .mockImplementation(runtime.factory);
    render(<ArenaGame runtimeFactory={factory} />);

    expect(
      await screen.findByRole('heading', { name: 'Renderer unavailable' }),
    ).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry renderer' }));
    expect(await screen.findByRole('button', { name: 'Drop in' })).not.toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('passes the current reduced-motion preference into the runtime', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        addEventListener:
          vi.fn<(type: string, listener: EventListenerOrEventListenerObject) => void>(),
        matches: true,
        removeEventListener:
          vi.fn<(type: string, listener: EventListenerOrEventListenerObject) => void>(),
      }),
    );
    const runtime = new FakeRuntime();
    render(<ArenaGame runtimeFactory={runtime.factory} />);

    expect(await screen.findByRole('button', { name: 'Drop in' })).not.toBeNull();
    expect(runtime.options?.reducedMotion).toBe(true);
  });

  it('keeps local entry primary and explains disabled online configuration', async () => {
    const user = userEvent.setup();
    const local = new FakeRuntime();
    const onlineFactory = vi.fn<OnlineArenaRuntimeDriverFactory>();
    render(
      <ArenaGame
        online={{
          enabled: false,
          reason: 'Public fields are offline for maintenance.',
        }}
        onlineRuntimeFactory={onlineFactory}
        runtimeFactory={local.factory}
      />,
    );

    const dropIn = await screen.findByRole('button', { name: 'Drop in' });
    const quickplay = screen.getByRole('button', { name: 'Public quickplay' });
    expect((quickplay as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText('Public fields are offline for maintenance.'),
    ).not.toBeNull();
    expect(onlineFactory).not.toHaveBeenCalled();

    await user.click(dropIn);
    expect(local.starts).toHaveLength(1);
    expect(onlineFactory).not.toHaveBeenCalled();
  });

  it('defaults online entry to disabled without invoking its factory', async () => {
    const local = new FakeRuntime();
    const onlineFactory = vi.fn<OnlineArenaRuntimeDriverFactory>();
    render(
      <ArenaGame onlineRuntimeFactory={onlineFactory} runtimeFactory={local.factory} />,
    );

    const dropIn = await screen.findByRole('button', { name: 'Drop in' });
    const quickplay = screen.getByRole('button', { name: 'Public quickplay' });
    expect((quickplay as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText('Public quickplay is not configured for this build.'),
    ).not.toBeNull();
    const briefing = dropIn.closest('section');
    expect(briefing?.querySelectorAll('button')[0]?.textContent).toContain('Drop in');
    expect(onlineFactory).not.toHaveBeenCalled();
  });

  it('does not invoke the enabled lazy online path until quickplay is activated', async () => {
    const user = userEvent.setup();
    const local = new FakeRuntime();
    const online = new OnlineFactoryHarness();
    render(
      <ArenaGame
        online={ONLINE_CONFIG}
        onlineRuntimeFactory={online.factory}
        runtimeFactory={local.factory}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Drop in' }));
    expect(local.starts).toHaveLength(1);
    expect(online.drivers).toHaveLength(0);
  });

  it('starts renderer-first quickplay and exposes semantic FFA status and roster', async () => {
    const { driver, local } = await enterOnline();
    expect(driver.startQuickplayCount).toBe(1);
    expect(local.drivers[0]?.disposeCount).toBe(1);
    expect(
      screen.getByRole('heading', { name: 'Connecting to public arena' }),
    ).not.toBeNull();

    connectOnline(driver);
    const status = screen.getByRole('region', { name: 'Public arena status' });
    expect(within(status).getByText('Continuous free-for-all')).not.toBeNull();
    expect(within(status).getByText('No rounds / no winner')).not.toBeNull();
    expect(within(status).getByText('2 / 8')).not.toBeNull();
    expect(within(status).getByLabelText('Player marker 3')).not.toBeNull();
    expect(within(status).getAllByText('ALPHA').length).toBeGreaterThan(0);
    expect(within(status).getAllByText('You').length).toBeGreaterThan(0);
    expect(
      (
        within(status).getByRole('progressbar', {
          name: 'Health',
        }) as HTMLProgressElement
      ).value,
    ).toBe(72);
    expect(
      (
        within(status).getByRole('progressbar', {
          name: 'Dash charge',
        }) as HTMLProgressElement
      ).value,
    ).toBe(50);
    expect(within(status).getByText('Stable')).not.toBeNull();

    const roster = within(status).getByRole('table', {
      name: 'Public free-for-all roster',
    });
    expect(within(roster).getByText('BRAVO')).not.toBeNull();
    expect(within(roster).getByText('ALPHA', { exact: false })).not.toBeNull();
  });

  it('opens a named live field menu through its control and keyboard callback', async () => {
    const { driver, user } = await enterOnline();
    connectOnline(driver);

    await user.click(screen.getByRole('button', { name: 'Field menu' }));
    expect(driver.openFieldMenuCount).toBe(1);
    expect(screen.getByRole('heading', { name: 'Field menu' })).not.toBeNull();
    expect(
      screen.getByText(/shared arena remains live.*avatar is vulnerable/i),
    ).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Run paused' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Leave arena' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Play local' })).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Return' }));
    expect(driver.closeFieldMenuCount).toBe(1);
    act(() => driver.options.onFieldMenuRequested());
    expect(screen.getByRole('heading', { name: 'Field menu' })).not.toBeNull();
    fireEvent.keyDown(window, { code: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'Field menu' })).toBeNull();
    expect(driver.closeFieldMenuCount).toBe(2);
  });

  it('shows reconnect grace without announcing every countdown tick', async () => {
    const { driver } = await enterOnline();
    connectOnline(driver);
    act(() => {
      driver.emitStatus('reconnecting');
      driver.emitReconnectGrace(8);
    });

    expect(
      screen.getByRole('heading', { name: 'Reconnecting to live arena' }),
    ).not.toBeNull();
    expect(screen.getByText(/8 seconds of reconnect grace remain\./)).not.toBeNull();
    const announcement = document.querySelector('output.sr-only')?.textContent;

    act(() => driver.emitReconnectGrace(7));
    expect(screen.getByText(/7 seconds of reconnect grace remain\./)).not.toBeNull();
    expect(document.querySelector('output.sr-only')?.textContent).toBe(announcement);
  });

  it.each([
    ['capacity', null, 'Public arena capacity reached', 'Retry online'],
    ['incompatible', null, 'Online version incompatible', 'Retry online'],
    ['expired', null, 'Arena session expired', 'Fresh quickplay'],
    ['draining', null, 'Online service draining', 'Retry online'],
    ['unavailable', 'transport', 'Online service unavailable', 'Retry online'],
  ] as const)(
    'renders bounded %s recovery actions',
    async (status, reason, heading, primaryAction) => {
      const { driver } = await enterOnline();
      act(() => {
        driver.emitStatus(status);
        if (reason) driver.emitUnavailable(reason);
      });

      expect(screen.getByRole('heading', { name: heading })).not.toBeNull();
      expect(screen.getByRole('button', { name: primaryAction })).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Leave arena' })).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Play local' })).not.toBeNull();
    },
  );

  it('supports retry, explicit fresh quickplay, and fresh local fallback', async () => {
    const { driver, local, user } = await enterOnline();
    act(() => {
      driver.emitStatus('unavailable');
      driver.emitUnavailable('transport');
    });

    await user.click(screen.getByRole('button', { name: 'Retry online' }));
    expect(driver.startQuickplayCount).toBe(2);
    act(() => {
      driver.emitStatus('unavailable');
      driver.emitUnavailable('transport');
    });
    await user.click(screen.getByRole('button', { name: 'Fresh quickplay' }));
    expect(driver.startFreshQuickplayCount).toBe(1);

    act(() => {
      driver.emitStatus('unavailable');
      driver.emitUnavailable('transport');
    });
    await user.click(screen.getByRole('button', { name: 'Play local' }));
    expect(await screen.findByRole('region', { name: 'Run status' })).not.toBeNull();
    expect(driver.leaveCount).toBe(1);
    expect(driver.disposeCount).toBe(1);
    expect(local.drivers).toHaveLength(2);
    expect(local.drivers[1]?.starts).toHaveLength(1);
  });

  it('leaves explicitly and reconstructs an idle local renderer', async () => {
    const { driver, local, user } = await enterOnline();
    connectOnline(driver);
    await user.click(screen.getByRole('button', { name: 'Field menu' }));
    await user.click(screen.getByRole('button', { name: 'Leave arena' }));

    expect(await screen.findByRole('button', { name: 'Drop in' })).not.toBeNull();
    expect(driver.leaveCount).toBe(1);
    expect(driver.disposeCount).toBe(1);
    expect(local.drivers).toHaveLength(2);
    expect(local.drivers[1]?.starts).toHaveLength(0);
  });

  it('reconstructs the online renderer and resumes the same session token path', async () => {
    const { driver, online, user } = await enterOnline();
    connectOnline(driver);
    act(() => {
      driver.emitStatus('unavailable');
      driver.emitUnavailable('renderer');
    });

    expect(
      screen.getByRole('heading', { name: 'Online renderer unavailable' }),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Retry renderer' })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry renderer' }));
    await waitFor(() => expect(online.drivers).toHaveLength(2));
    const replacement = online.drivers[1];
    expect(driver.disposeCount).toBe(1);
    expect(replacement?.resumeSessionCount).toBe(1);
    expect(replacement?.startQuickplayCount).toBe(0);
  });

  it('reports pre-admission renderer failure and retries without resuming identity', async () => {
    const user = userEvent.setup();
    const local = new LocalFactoryHarness();
    const drivers: FakeOnlineRuntime[] = [];
    let calls = 0;
    const onlineFactory: OnlineArenaRuntimeDriverFactory = (options) => {
      calls += 1;
      if (calls === 1) throw new Error('renderer failed');
      const driver = new FakeOnlineRuntime(options);
      drivers.push(driver);
      return driver;
    };
    render(
      <ArenaGame
        online={ONLINE_CONFIG}
        onlineRuntimeFactory={onlineFactory}
        runtimeFactory={local.factory}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Public quickplay' }));

    expect(
      await screen.findByRole('heading', { name: 'Online renderer unavailable' }),
    ).not.toBeNull();
    expect(screen.getByText(/no online admission was started/i)).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry renderer' }));
    await waitFor(() => expect(drivers).toHaveLength(1));
    expect(drivers[0]?.startQuickplayCount).toBe(1);
    expect(drivers[0]?.resumeSessionCount).toBe(0);
  });

  it('disposes a late online factory result once without starting admission', async () => {
    const user = userEvent.setup();
    const local = new LocalFactoryHarness();
    let resolveOnline: ((runtime: OnlineArenaRuntimeDriver) => void) | null = null;
    let capturedOptions: OnlineArenaRuntimeDriverOptions | null = null;
    const pending = new Promise<OnlineArenaRuntimeDriver>((resolve) => {
      resolveOnline = resolve;
    });
    const onlineFactory: OnlineArenaRuntimeDriverFactory = (options) => {
      capturedOptions = options;
      return pending;
    };
    render(
      <ArenaGame
        online={ONLINE_CONFIG}
        onlineRuntimeFactory={onlineFactory}
        runtimeFactory={local.factory}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Public quickplay' }));
    await user.click(screen.getByRole('button', { name: 'Play local' }));
    expect(await screen.findByRole('region', { name: 'Run status' })).not.toBeNull();
    if (!capturedOptions || !resolveOnline) throw new Error('Expected pending factory');
    const lateDriver = new FakeOnlineRuntime(capturedOptions);
    await act(async () => {
      resolveOnline?.(lateDriver);
      await pending;
    });

    expect(lateDriver.startQuickplayCount).toBe(0);
    expect(lateDriver.disposeCount).toBe(1);
  });

  it('disposes each StrictMode runtime owner exactly once', async () => {
    const local = new LocalFactoryHarness();
    const view = render(
      <StrictMode>
        <ArenaGame runtimeFactory={local.factory} />
      </StrictMode>,
    );
    expect(await screen.findByRole('button', { name: 'Drop in' })).not.toBeNull();
    expect(local.drivers.length).toBeGreaterThanOrEqual(2);

    view.unmount();
    await waitFor(() => {
      expect(local.drivers.every((driver) => driver.disposeCount === 1)).toBe(true);
    });
  });

  it('routes touch controls online and resets them on interruption and reconnect', async () => {
    const { driver } = await enterOnline();
    connectOnline(driver);
    const move = screen.getByLabelText('Move stick') as HTMLButtonElement;
    const aim = screen.getByLabelText('Aim and fire stick') as HTMLButtonElement;
    const bounds: DOMRect = {
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    vi.spyOn(move, 'getBoundingClientRect').mockReturnValue(bounds);
    vi.spyOn(aim, 'getBoundingClientRect').mockReturnValue(bounds);
    Object.defineProperty(move, 'setPointerCapture', {
      configurable: true,
      value: vi.fn<(pointerId: number) => void>(),
    });
    Object.defineProperty(aim, 'setPointerCapture', {
      configurable: true,
      value: vi.fn<(pointerId: number) => void>(),
    });

    fireEvent.pointerDown(move, { clientX: 82, clientY: 50, pointerId: 1 });
    fireEvent.pointerDown(aim, { clientX: 50, clientY: 18, pointerId: 2 });
    fireEvent.pointerDown(screen.getByLabelText('Dash'), { pointerId: 3 });
    expect(driver.touchMove.at(-1)).toEqual({ x: 1, y: -0 });
    expect(driver.touchAim.at(-1)).toEqual({ direction: { x: 0, y: 1 }, firing: true });
    expect(driver.dashCount).toBe(1);

    act(() => driver.emitInputReset());
    expect(move.style.getPropertyValue('--stick-x')).toBe('0px');
    expect(move.style.getPropertyValue('--stick-y')).toBe('0px');
    act(() => driver.emitStatus('reconnecting'));
    expect(move.disabled).toBe(true);
    expect(aim.disabled).toBe(true);
    expect((screen.getByLabelText('Dash') as HTMLButtonElement).disabled).toBe(true);
  });

  it('resets controls and announces only elimination and respawn transitions', async () => {
    const { driver } = await enterOnline();
    connectOnline(driver);
    const move = screen.getByLabelText('Move stick') as HTMLButtonElement;
    act(() =>
      driver.emitHud({
        ...ONLINE_HUD,
        health: 0,
        respawnSeconds: 2,
        status: 'eliminated',
      }),
    );
    expect(screen.getByText('Eliminated / respawn in 2 seconds')).not.toBeNull();
    expect(move.disabled).toBe(true);
    expect(document.querySelector('output.sr-only')?.textContent).toBe(
      'Eliminated. Respawn in 2 seconds.',
    );

    act(() => driver.emitHud(ONLINE_HUD));
    expect(document.querySelector('output.sr-only')?.textContent).toBe(
      'Respawned in the live arena.',
    );
  });

  it('keeps essential online semantics and roster disclosure available at 320px', async () => {
    vi.stubGlobal('innerWidth', 320);
    const { driver } = await enterOnline();
    connectOnline(driver);

    const status = screen.getByRole('region', { name: 'Public arena status' });
    const rosterSummary = within(status).getByText('Field roster').closest('summary');
    expect(rosterSummary?.parentElement?.tagName).toBe('DETAILS');
    expect(within(status).getByRole('progressbar', { name: 'Health' })).not.toBeNull();
    expect(within(status).getByText('Life state')).not.toBeNull();
    expect(within(status).getByRole('button', { name: 'Field menu' })).not.toBeNull();
    expect(screen.getByLabelText('Move stick')).not.toBeNull();
    expect(screen.getByLabelText('Aim and fire stick')).not.toBeNull();
  });

  it('passes reduced motion to lazily constructed online presentation', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        addEventListener:
          vi.fn<(type: string, listener: EventListenerOrEventListenerObject) => void>(),
        matches: true,
        removeEventListener:
          vi.fn<(type: string, listener: EventListenerOrEventListenerObject) => void>(),
      }),
    );
    const { driver } = await enterOnline();
    expect(driver.options.reducedMotion).toBe(true);
    expect(
      document.querySelector('.arena-app')?.classList.contains('is-reduced-motion'),
    ).toBe(true);
  });
});
