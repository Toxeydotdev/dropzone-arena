import { useEffect, useRef, useState } from 'react';

import type { Vector2 } from '@dropzone-arena/arena-engine';

import {
  defaultArenaRuntimeDriverFactory,
  type ArenaHudSnapshot,
  type ArenaRuntimeDriver,
  type ArenaRuntimeDriverFactory,
} from './arena-runtime-driver';
import {
  defaultOnlineArenaRuntimeDriverFactory,
  type OnlineArenaConfig,
  type OnlineArenaHudSnapshot,
  type OnlineArenaRuntimeDriver,
  type OnlineArenaRuntimeDriverFactory,
  type OnlineArenaStatus,
  type OnlineArenaUnavailableReason,
} from './online-arena-runtime-driver';
import { useReducedMotion } from './use-reduced-motion';
import { VirtualStick } from './virtual-stick';

type GameStage = 'loading' | 'ready' | 'playing' | 'paused' | 'debrief' | 'unavailable';

type OwnerRequest =
  | { generation: number; kind: 'local'; startOnReady: boolean }
  | {
      action: 'quickplay' | 'resume';
      generation: number;
      kind: 'online';
    };

const DEFAULT_ONLINE_CONFIG: OnlineArenaConfig = {
  enabled: false,
  reason: 'Public quickplay is not configured for this build.',
};

const INITIAL_HUD: ArenaHudSnapshot = {
  combo: 0,
  dashReady: 1,
  enemyCount: 0,
  health: 100,
  overdriveTime: 0,
  score: 0,
  stats: { damageTaken: 0, eliminations: 0, hits: 0, shots: 0 },
  status: 'playing',
  timeRemaining: 90,
  wave: 1,
};

export interface ArenaGameProps {
  online?: OnlineArenaConfig;
  onlineRuntimeFactory?: OnlineArenaRuntimeDriverFactory;
  runtimeFactory?: ArenaRuntimeDriverFactory;
}

export function ArenaGame({
  online = DEFAULT_ONLINE_CONFIG,
  onlineRuntimeFactory = defaultOnlineArenaRuntimeDriverFactory,
  runtimeFactory = defaultArenaRuntimeDriverFactory,
}: ArenaGameProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ArenaRuntimeDriver | null>(null);
  const onlineRuntimeRef = useRef<OnlineArenaRuntimeDriver | null>(null);
  const onlineConfigRef = useRef(online);
  onlineConfigRef.current = online;
  const runNumberRef = useRef(0);
  const ownerGenerationRef = useRef(0);
  const exitOperationRef = useRef(0);
  const mountedRef = useRef(false);
  const disposedDriversRef = useRef(new WeakSet<object>());
  const onlineAdmissionStartedRef = useRef(false);
  const previousOnlineStatusRef = useRef<OnlineArenaStatus | null>(null);
  const previousOnlineLifeRef = useRef<'alive' | 'eliminated' | null>(null);
  const reducedMotion = useReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const [ownerRequest, setOwnerRequest] = useState<OwnerRequest>({
    generation: 0,
    kind: 'local',
    startOnReady: false,
  });
  const [stage, setStage] = useState<GameStage>('loading');
  const [hud, setHud] = useState<ArenaHudSnapshot>(INITIAL_HUD);
  const [onlineHud, setOnlineHud] = useState<OnlineArenaHudSnapshot | null>(null);
  const [onlineStatus, setOnlineStatus] = useState<OnlineArenaStatus>('connecting');
  const [onlineUnavailableReason, setOnlineUnavailableReason] =
    useState<OnlineArenaUnavailableReason | null>(null);
  const [reconnectGraceSeconds, setReconnectGraceSeconds] = useState<number | null>(
    null,
  );
  const [fieldMenuOpen, setFieldMenuOpen] = useState(false);
  const [onlineExitPending, setOnlineExitPending] = useState(false);
  const [touchResetGeneration, setTouchResetGeneration] = useState(0);
  const [announcement, setAnnouncement] = useState('Calibrating arena.');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      exitOperationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const generation = ownerRequest.generation;
    const disposedDrivers = disposedDriversRef.current;
    let active = true;
    let ownedDriver: ArenaRuntimeDriver | OnlineArenaRuntimeDriver | null = null;
    const isCurrent = (): boolean =>
      active && ownerGenerationRef.current === generation;

    if (ownerRequest.kind === 'local') {
      setStage('loading');
      setAnnouncement('Calibrating arena.');
      void (async () => {
        try {
          const runtime = await runtimeFactory({
            host,
            onPauseRequested: () => {
              if (!isCurrent()) return;
              setStage((current) => (current === 'playing' ? 'paused' : current));
              setAnnouncement('Run paused.');
            },
            onRunEnded: (snapshot) => {
              if (!isCurrent()) return;
              setHud(snapshot);
              setStage('debrief');
              setAnnouncement(
                snapshot.status === 'extracted'
                  ? 'Extraction complete.'
                  : 'Run ended. Signal lost.',
              );
            },
            onSnapshot: (snapshot) => {
              if (isCurrent()) setHud(snapshot);
            },
            onUnavailable: () => {
              if (!isCurrent()) return;
              setStage('unavailable');
              setAnnouncement('Arena renderer unavailable.');
            },
            reducedMotion: reducedMotionRef.current,
          });
          if (!isCurrent()) {
            disposeDriverOnce(runtime, disposedDrivers);
            return;
          }
          ownedDriver = runtime;
          runtimeRef.current = runtime;
          if (ownerRequest.startOnReady) {
            runNumberRef.current += 1;
            setHud(INITIAL_HUD);
            setStage('playing');
            setAnnouncement('Local run started. Survive for 90 seconds.');
            runtime.start(createRunSeed(runNumberRef.current));
            host.focus({ preventScroll: true });
          } else {
            setStage('ready');
            setAnnouncement('Arena ready.');
          }
        } catch {
          if (!isCurrent()) return;
          setStage('unavailable');
          setAnnouncement('Arena renderer unavailable.');
        }
      })();
    } else {
      const config = onlineConfigRef.current;
      setOnlineUnavailableReason(null);
      setOnlineStatus(ownerRequest.action === 'resume' ? 'reconnecting' : 'connecting');
      setAnnouncement(
        ownerRequest.action === 'resume'
          ? 'Rebuilding the online field view.'
          : 'Connecting to a public arena.',
      );
      if (!config.enabled) {
        setOnlineStatus('unavailable');
        setOnlineUnavailableReason('transport');
      } else {
        void (async () => {
          try {
            const runtime = await onlineRuntimeFactory({
              config,
              host,
              onFieldMenuRequested: () => {
                if (!isCurrent()) return;
                setFieldMenuOpen(true);
                setTouchResetGeneration((value) => value + 1);
                setAnnouncement('Field menu open. The shared arena remains live.');
              },
              onHudSnapshot: (snapshot) => {
                if (!isCurrent()) return;
                const previousLife = previousOnlineLifeRef.current;
                previousOnlineLifeRef.current = snapshot.status;
                setOnlineHud(snapshot);
                if (previousLife === 'alive' && snapshot.status === 'eliminated') {
                  setTouchResetGeneration((value) => value + 1);
                  setAnnouncement(
                    `Eliminated. Respawn in ${formatSeconds(snapshot.respawnSeconds)}.`,
                  );
                } else if (
                  previousLife === 'eliminated' &&
                  snapshot.status === 'alive'
                ) {
                  setAnnouncement('Respawned in the live arena.');
                }
              },
              onInputReset: () => {
                if (isCurrent()) setTouchResetGeneration((value) => value + 1);
              },
              onReconnectGraceChanged: (remainingSeconds) => {
                if (isCurrent()) setReconnectGraceSeconds(remainingSeconds);
              },
              onStatus: (status) => {
                if (!isCurrent()) return;
                const previousStatus = previousOnlineStatusRef.current;
                previousOnlineStatusRef.current = status;
                setOnlineStatus(status);
                if (status === 'reconnecting') {
                  setFieldMenuOpen(false);
                  setTouchResetGeneration((value) => value + 1);
                  if (previousStatus !== 'reconnecting') {
                    setAnnouncement(
                      'Connection interrupted. Reconnecting to the arena.',
                    );
                  }
                } else if (status === 'connected') {
                  if (previousStatus === 'reconnecting') {
                    setAnnouncement('Connection restored.');
                  } else if (previousStatus === 'connecting') {
                    setAnnouncement('Public arena connected.');
                  }
                } else if (status === 'draining') {
                  setAnnouncement('The online service is draining.');
                } else if (status === 'expired') {
                  setAnnouncement('The anonymous arena session expired.');
                } else if (status === 'incompatible') {
                  setAnnouncement('Online client and service are incompatible.');
                } else if (status === 'capacity') {
                  setAnnouncement('Public arena capacity is currently full.');
                }
              },
              onUnavailable: (reason) => {
                if (!isCurrent()) return;
                setOnlineUnavailableReason(reason);
                setOnlineStatus('unavailable');
                setFieldMenuOpen(false);
                setTouchResetGeneration((value) => value + 1);
                setAnnouncement(
                  reason === 'renderer'
                    ? 'Online renderer unavailable. The shared arena could not pause.'
                    : 'Online service unavailable.',
                );
              },
              reducedMotion: reducedMotionRef.current,
            });
            if (!isCurrent()) {
              disposeDriverOnce(runtime, disposedDrivers);
              return;
            }
            ownedDriver = runtime;
            onlineRuntimeRef.current = runtime;
            onlineAdmissionStartedRef.current = true;
            if (ownerRequest.action === 'resume') await runtime.resumeSession();
            else await runtime.startQuickplay();
          } catch {
            if (!isCurrent()) return;
            setOnlineUnavailableReason(ownedDriver === null ? 'renderer' : 'transport');
            setOnlineStatus('unavailable');
            setAnnouncement(
              ownedDriver === null
                ? 'Online renderer unavailable. No session was created.'
                : 'Online service unavailable.',
            );
          }
        })();
      }
    }

    return () => {
      active = false;
      if (runtimeRef.current === ownedDriver) runtimeRef.current = null;
      if (onlineRuntimeRef.current === ownedDriver) onlineRuntimeRef.current = null;
      disposeDriverOnce(ownedDriver, disposedDrivers);
    };
  }, [onlineRuntimeFactory, ownerRequest, runtimeFactory]);

  useEffect(() => {
    runtimeRef.current?.setReducedMotion(reducedMotion);
    onlineRuntimeRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  useEffect(() => {
    if (!fieldMenuOpen || ownerRequest.kind !== 'online') return;
    const handleFieldMenuKey = (event: KeyboardEvent): void => {
      if (event.code !== 'Escape' && event.code !== 'KeyP') return;
      event.preventDefault();
      onlineRuntimeRef.current?.closeFieldMenu();
      setFieldMenuOpen(false);
      setAnnouncement('Returned to the live arena.');
      hostRef.current?.focus({ preventScroll: true });
    };
    globalThis.addEventListener('keydown', handleFieldMenuKey);
    return () => globalThis.removeEventListener('keydown', handleFieldMenuKey);
  }, [fieldMenuOpen, ownerRequest.kind]);

  const requestOwner = (
    request:
      | Omit<Extract<OwnerRequest, { kind: 'local' }>, 'generation'>
      | Omit<Extract<OwnerRequest, { kind: 'online' }>, 'generation'>,
  ): void => {
    ownerGenerationRef.current += 1;
    setOwnerRequest({ ...request, generation: ownerGenerationRef.current });
  };

  const startRun = () => {
    if (ownerRequest.kind !== 'local') return;
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runNumberRef.current += 1;
    setHud(INITIAL_HUD);
    setStage('playing');
    setAnnouncement('Run started. Survive for 90 seconds.');
    runtime.start(createRunSeed(runNumberRef.current));
    hostRef.current?.focus({ preventScroll: true });
  };

  const pauseRun = () => {
    if (stage !== 'playing') return;
    runtimeRef.current?.pause();
    setStage('paused');
    setAnnouncement('Run paused.');
  };

  const resumeRun = () => {
    if (stage !== 'paused') return;
    runtimeRef.current?.resume();
    setStage('playing');
    setAnnouncement('Run resumed.');
    hostRef.current?.focus({ preventScroll: true });
  };

  const retryRenderer = () => {
    requestOwner({ kind: 'local', startOnReady: false });
  };

  const setLocalTouchMove = (direction: Vector2) => {
    runtimeRef.current?.setTouchMove({ x: direction.x, y: -direction.y });
  };

  const setLocalTouchAim = (direction: Vector2, active: boolean) => {
    runtimeRef.current?.setTouchAim({ x: direction.x, y: -direction.y }, active);
  };

  const startOnlineQuickplay = (): void => {
    if (!online.enabled) return;
    onlineAdmissionStartedRef.current = false;
    previousOnlineLifeRef.current = null;
    previousOnlineStatusRef.current = 'connecting';
    setOnlineHud(null);
    setOnlineUnavailableReason(null);
    setReconnectGraceSeconds(null);
    setFieldMenuOpen(false);
    setOnlineStatus('connecting');
    requestOwner({ action: 'quickplay', kind: 'online' });
  };

  const retryOnline = (): void => {
    const runtime = onlineRuntimeRef.current;
    const generation = ownerRequest.generation;
    setOnlineUnavailableReason(null);
    setReconnectGraceSeconds(null);
    setOnlineStatus('connecting');
    setAnnouncement('Retrying public quickplay.');
    if (!runtime) {
      requestOwner({ action: 'quickplay', kind: 'online' });
      return;
    }
    void runtime.startQuickplay().catch(() => {
      if (ownerGenerationRef.current !== generation) return;
      setOnlineUnavailableReason('transport');
      setOnlineStatus('unavailable');
      setAnnouncement('Online service unavailable.');
    });
  };

  const startFreshQuickplay = (): void => {
    const runtime = onlineRuntimeRef.current;
    const generation = ownerRequest.generation;
    onlineAdmissionStartedRef.current = true;
    previousOnlineLifeRef.current = null;
    setOnlineHud(null);
    setOnlineUnavailableReason(null);
    setReconnectGraceSeconds(null);
    setFieldMenuOpen(false);
    setOnlineStatus('connecting');
    setAnnouncement('Requesting a fresh anonymous quickplay session.');
    if (!runtime) {
      requestOwner({ action: 'quickplay', kind: 'online' });
      return;
    }
    void runtime.startFreshQuickplay().catch(() => {
      if (ownerGenerationRef.current !== generation) return;
      setOnlineUnavailableReason('transport');
      setOnlineStatus('unavailable');
      setAnnouncement('Online service unavailable.');
    });
  };

  const retryOnlineRenderer = (): void => {
    const action = onlineAdmissionStartedRef.current ? 'resume' : 'quickplay';
    setOnlineUnavailableReason(null);
    setReconnectGraceSeconds(null);
    setFieldMenuOpen(false);
    setTouchResetGeneration((value) => value + 1);
    requestOwner({ action, kind: 'online' });
  };

  const openFieldMenu = (): void => {
    onlineRuntimeRef.current?.openFieldMenu();
    setFieldMenuOpen(true);
    setTouchResetGeneration((value) => value + 1);
    setAnnouncement('Field menu open. The shared arena remains live.');
  };

  const closeFieldMenu = (): void => {
    onlineRuntimeRef.current?.closeFieldMenu();
    setFieldMenuOpen(false);
    setAnnouncement('Returned to the live arena.');
    hostRef.current?.focus({ preventScroll: true });
  };

  const exitOnline = (startLocal: boolean): void => {
    const operation = exitOperationRef.current + 1;
    exitOperationRef.current = operation;
    ownerGenerationRef.current += 1;
    const generation = ownerGenerationRef.current;
    setOnlineExitPending(true);
    setFieldMenuOpen(false);
    setTouchResetGeneration((value) => value + 1);
    const runtime = onlineRuntimeRef.current;
    void (async () => {
      try {
        await runtime?.leave();
      } catch {
        // Local play and explicit exit remain available after a failed leave ack.
      }
      if (!mountedRef.current || exitOperationRef.current !== operation) return;
      onlineAdmissionStartedRef.current = false;
      previousOnlineLifeRef.current = null;
      previousOnlineStatusRef.current = null;
      setOnlineHud(null);
      setOnlineUnavailableReason(null);
      setReconnectGraceSeconds(null);
      setOnlineExitPending(false);
      setOwnerRequest({ generation, kind: 'local', startOnReady: startLocal });
    })();
  };

  const setOnlineTouchMove = (direction: Vector2): void => {
    onlineRuntimeRef.current?.setTouchMove({ x: direction.x, y: -direction.y });
  };

  const setOnlineTouchAim = (direction: Vector2, active: boolean): void => {
    onlineRuntimeRef.current?.setTouchAim({ x: direction.x, y: -direction.y }, active);
  };

  const showHud = stage === 'playing' || stage === 'paused' || stage === 'debrief';
  const onlineMode = ownerRequest.kind === 'online';
  const onlineControlsVisible = onlineMode && onlineHud !== null;
  const onlineControlsDisabled =
    fieldMenuOpen ||
    onlineHud?.status !== 'alive' ||
    (onlineStatus !== 'connected' && onlineStatus !== 'delayed');
  const appStage = onlineMode ? `online-${onlineStatus}` : stage;

  return (
    <div
      className={`arena-app arena-app--${appStage}${onlineMode ? ' arena-app--online' : ''}${reducedMotion ? ' is-reduced-motion' : ''}`}
    >
      <div
        ref={hostRef}
        className="arena-render-host"
        tabIndex={-1}
        onContextMenu={(event) => event.preventDefault()}
      />

      <div className="arena-noise" aria-hidden="true" />
      <div className="arena-vignette" aria-hidden="true" />

      <header className="signal-header">
        <div className="signal-brand" aria-label="Dropzone Arena">
          <span className="signal-brand__mark" aria-hidden="true">
            DZ
          </span>
          <span className="signal-brand__type">
            <strong>Dropzone</strong>
            <small>Arena / {onlineMode ? 'public field' : 'local signal'}</small>
          </span>
        </div>
        <div className="signal-status">
          <span className="signal-status__light" aria-hidden="true" />
          <span>
            {onlineMode
              ? onlineConnectionLabel(onlineStatus, onlineUnavailableReason)
              : stage === 'unavailable'
                ? 'Renderer offline'
                : 'Local field online'}
          </span>
        </div>
      </header>

      {!onlineMode && showHud ? (
        <ArenaHud snapshot={hud} onPause={pauseRun} stage={stage} />
      ) : null}
      {onlineMode && onlineHud ? (
        <OnlineArenaHud
          onFieldMenu={openFieldMenu}
          snapshot={onlineHud}
          status={onlineStatus}
          reconnectGraceSeconds={reconnectGraceSeconds}
        />
      ) : null}

      <main className="arena-overlay-layer">
        {onlineMode ? (
          <OnlineOverlay
            exitPending={onlineExitPending}
            fieldMenuOpen={fieldMenuOpen}
            hadSession={
              onlineHud !== null ||
              (onlineUnavailableReason === 'renderer' &&
                onlineAdmissionStartedRef.current)
            }
            onCloseFieldMenu={closeFieldMenu}
            onFreshQuickplay={startFreshQuickplay}
            onLeave={() => exitOnline(false)}
            onPlayLocal={() => exitOnline(true)}
            onRetryOnline={retryOnline}
            onRetryRenderer={retryOnlineRenderer}
            reconnectGraceSeconds={reconnectGraceSeconds}
            status={onlineStatus}
            unavailableReason={onlineUnavailableReason}
          />
        ) : (
          <>
            {stage === 'loading' ? <LoadingPanel /> : null}
            {stage === 'ready' ? (
              <ReadyPanel
                online={online}
                onOnline={startOnlineQuickplay}
                onStart={startRun}
              />
            ) : null}
            {stage === 'paused' ? (
              <PausedPanel onRestart={startRun} onResume={resumeRun} />
            ) : null}
            {stage === 'debrief' ? (
              <DebriefPanel snapshot={hud} onRestart={startRun} />
            ) : null}
            {stage === 'unavailable' ? (
              <UnavailablePanel onRetry={retryRenderer} />
            ) : null}
          </>
        )}
      </main>

      {!onlineMode && stage === 'playing' ? (
        <TouchCombatControls
          onAim={setLocalTouchAim}
          onDash={() => runtimeRef.current?.triggerDash()}
          onMove={setLocalTouchMove}
        />
      ) : null}
      {onlineControlsVisible ? (
        <TouchCombatControls
          disabled={onlineControlsDisabled}
          onAim={setOnlineTouchAim}
          onDash={() => onlineRuntimeRef.current?.triggerDash()}
          onMove={setOnlineTouchMove}
          resetKey={touchResetGeneration}
        />
      ) : null}

      <output className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </output>
    </div>
  );
}

function ArenaHud({
  onPause,
  snapshot,
  stage,
}: {
  onPause(): void;
  snapshot: ArenaHudSnapshot;
  stage: GameStage;
}) {
  const healthPercent = Math.max(0, Math.min(100, snapshot.health));
  const dashPercent = Math.round(snapshot.dashReady * 100);
  return (
    <section className="combat-hud" aria-label="Run status">
      <div
        className="hud-timer"
        aria-label={`${formatClock(snapshot.timeRemaining)} remaining`}
      >
        <span className="hud-label">Time to clear</span>
        <strong className={snapshot.timeRemaining <= 15 ? 'is-critical' : undefined}>
          {formatClock(snapshot.timeRemaining)}
        </strong>
        <span className="hud-timer__ticks" aria-hidden="true" />
      </div>

      <div className="hud-score">
        <span className="hud-label">Field score</span>
        <strong>{snapshot.score.toString().padStart(6, '0')}</strong>
        <span className="hud-score__meta">
          {snapshot.combo > 1 ? `Chain x${snapshot.combo}` : 'Chain idle'}
        </span>
      </div>

      <div className="hud-wave">
        <span className="hud-label">Pressure</span>
        <strong>Wave {snapshot.wave} / 5</strong>
        <span>{snapshot.enemyCount} contacts</span>
      </div>

      <div className="hud-health">
        <div className="hud-health__line">
          <span className="hud-label">Suit integrity</span>
          <strong>{Math.ceil(healthPercent)}%</strong>
        </div>
        <progress
          className="meter meter--health"
          aria-label="Suit integrity"
          max={100}
          value={healthPercent}
        />
        <div className="hud-health__subline">
          <span>
            {snapshot.overdriveTime > 0 ? 'Overdrive active' : 'Standard output'}
          </span>
          <span>{snapshot.stats.eliminations} cleared</span>
        </div>
      </div>

      <div className="hud-dash">
        <span className="hud-label">Impulse</span>
        <progress
          className="meter meter--dash"
          aria-label="Dash charge"
          max={100}
          value={dashPercent}
        />
        <strong>{dashPercent >= 100 ? 'Ready' : 'Charging'}</strong>
      </div>

      {stage === 'playing' ? (
        <button className="pause-control" type="button" onClick={onPause}>
          <span aria-hidden="true">II</span>
          Pause
        </button>
      ) : null}

      <p className="hud-objective">
        <span aria-hidden="true">01</span>
        Hold the yard. Break contact. Make the clear.
      </p>
    </section>
  );
}

function OnlineArenaHud({
  onFieldMenu,
  reconnectGraceSeconds,
  snapshot,
  status,
}: {
  onFieldMenu(): void;
  reconnectGraceSeconds: number | null;
  snapshot: OnlineArenaHudSnapshot;
  status: OnlineArenaStatus;
}) {
  const [rosterOpen, setRosterOpen] = useState(true);
  const healthPercent = Math.max(0, Math.min(100, snapshot.health));
  const dashPercent = Math.round(Math.max(0, Math.min(1, snapshot.dashReady)) * 100);
  const lifeLabel =
    snapshot.status === 'alive'
      ? 'Active'
      : `Eliminated / respawn in ${formatSeconds(snapshot.respawnSeconds)}`;

  return (
    <section className="online-hud" aria-label="Public arena status">
      <div className="online-hud__objective">
        <span className="hud-label">Public field order</span>
        <strong>Continuous free-for-all</strong>
        <span>No rounds / no winner</span>
      </div>

      <div className="online-hud__identity">
        <span className="online-marker" aria-label={`Player marker ${snapshot.marker}`}>
          #{snapshot.marker}
        </span>
        <span>
          <span className="hud-label">Generated callsign</span>
          <strong>{snapshot.callsign}</strong>
        </span>
        <b>You</b>
      </div>

      <div className="online-hud__connection">
        <span className="hud-label">Field link</span>
        <strong>{onlineConnectionLabel(status, null)}</strong>
        {status === 'reconnecting' && reconnectGraceSeconds !== null ? (
          <span>{reconnectGraceSeconds}s grace remaining</span>
        ) : null}
      </div>

      <button className="field-menu-control" type="button" onClick={onFieldMenu}>
        Field menu
      </button>

      <div className="online-hud__vitals">
        <div className="online-meter">
          <span className="hud-label">Health</span>
          <strong>{Math.ceil(healthPercent)}%</strong>
          <progress
            className="meter meter--health"
            aria-label="Health"
            max={100}
            value={healthPercent}
          />
        </div>
        <div className="online-meter">
          <span className="hud-label">Dash</span>
          <strong>{dashPercent >= 100 ? 'Ready' : `${dashPercent}%`}</strong>
          <progress
            className="meter meter--dash"
            aria-label="Dash charge"
            max={100}
            value={dashPercent}
          />
        </div>
        <div className="online-life">
          <span className="hud-label">Life state</span>
          <strong>{lifeLabel}</strong>
        </div>
        <dl className="online-session-stats" aria-label="Session statistics">
          <div>
            <dt>Kills</dt>
            <dd>{snapshot.kills}</dd>
          </div>
          <div>
            <dt>Deaths</dt>
            <dd>{snapshot.deaths}</dd>
          </div>
        </dl>
      </div>

      <details
        className="online-roster"
        open={rosterOpen}
        onToggle={(event) => setRosterOpen(event.currentTarget.open)}
      >
        <summary>
          <span>Field roster</span>
          <strong>{snapshot.population} / 8</strong>
        </summary>
        <table>
          <caption className="sr-only">Public free-for-all roster</caption>
          <thead>
            <tr>
              <th scope="col">Marker</th>
              <th scope="col">Callsign</th>
              <th scope="col">K</th>
              <th scope="col">D</th>
              <th scope="col">Life</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.roster.map((entry) => (
              <tr key={`${entry.marker}-${entry.callsign}`}>
                <td>
                  <span className="online-marker">#{entry.marker}</span>
                </td>
                <th scope="row">
                  {entry.callsign} {entry.you ? <b>You</b> : null}
                </th>
                <td>{entry.kills}</td>
                <td>{entry.deaths}</td>
                <td>{entry.status === 'alive' ? 'Active' : 'Eliminated'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function TouchCombatControls({
  disabled = false,
  onAim,
  onDash,
  onMove,
  resetKey = 0,
}: {
  disabled?: boolean;
  onAim(direction: Vector2, active: boolean): void;
  onDash(): void;
  onMove(direction: Vector2): void;
  resetKey?: number;
}) {
  return (
    <div className="mobile-controls" aria-label="Touch combat controls">
      <VirtualStick
        disabled={disabled}
        label="Move stick"
        onChange={(direction) => onMove(direction)}
        resetKey={resetKey}
      />
      <button
        className="dash-control"
        type="button"
        aria-label="Dash"
        disabled={disabled}
        onPointerDown={(event) => {
          event.preventDefault();
          onDash();
        }}
      >
        <span aria-hidden="true">DASH</span>
      </button>
      <VirtualStick
        disabled={disabled}
        label="Aim and fire stick"
        onChange={onAim}
        resetKey={resetKey}
      />
    </div>
  );
}

function OnlineOverlay({
  exitPending,
  fieldMenuOpen,
  hadSession,
  onCloseFieldMenu,
  onFreshQuickplay,
  onLeave,
  onPlayLocal,
  onRetryOnline,
  onRetryRenderer,
  reconnectGraceSeconds,
  status,
  unavailableReason,
}: {
  exitPending: boolean;
  fieldMenuOpen: boolean;
  hadSession: boolean;
  onCloseFieldMenu(): void;
  onFreshQuickplay(): void;
  onLeave(): void;
  onPlayLocal(): void;
  onRetryOnline(): void;
  onRetryRenderer(): void;
  reconnectGraceSeconds: number | null;
  status: OnlineArenaStatus;
  unavailableReason: OnlineArenaUnavailableReason | null;
}) {
  if (exitPending) {
    return (
      <section
        className="system-panel online-state-panel"
        aria-labelledby="leaving-title"
      >
        <span className="system-kicker">Public field / release</span>
        <h1 id="leaving-title">Leaving arena</h1>
        <p>Releasing the ephemeral session and clearing held controls.</p>
      </section>
    );
  }
  if (fieldMenuOpen) {
    return (
      <section
        className="system-panel field-menu-panel"
        aria-labelledby="field-menu-title"
      >
        <span className="system-kicker">Public field / live interruption</span>
        <h1 id="field-menu-title">Field menu</h1>
        <p>
          The shared arena remains live. Your avatar is vulnerable while this menu is
          open. Online play is not paused.
        </p>
        <div className="system-panel__actions">
          <button
            className="primary-action primary-action--compact"
            type="button"
            onClick={onCloseFieldMenu}
          >
            <span>Return</span>
            <span aria-hidden="true">&gt;</span>
          </button>
          <button className="text-action" type="button" onClick={onLeave}>
            Leave arena
          </button>
          <button className="text-action" type="button" onClick={onPlayLocal}>
            Play local
          </button>
        </div>
      </section>
    );
  }
  if (status === 'connected' || status === 'delayed') return null;
  if (status === 'connecting') {
    return (
      <section
        className="system-panel online-state-panel"
        aria-labelledby="connecting-title"
      >
        <span className="system-kicker">Public field / anonymous admission</span>
        <h1 id="connecting-title">Connecting to public arena</h1>
        <div className="calibration-track" aria-hidden="true">
          <span />
        </div>
        <p>No account, custom identity, room code, or prematch lobby is created.</p>
        <div className="system-panel__actions">
          <button className="text-action" type="button" onClick={onLeave}>
            Leave arena
          </button>
          <button className="text-action" type="button" onClick={onPlayLocal}>
            Play local
          </button>
        </div>
      </section>
    );
  }
  if (status === 'reconnecting') {
    return (
      <section
        className="system-panel online-state-panel"
        aria-labelledby="reconnecting-title"
      >
        <span className="system-kicker">Public field / live reconnect</span>
        <h1 id="reconnecting-title">Reconnecting to live arena</h1>
        <p>
          The shared arena remains live and your avatar is vulnerable.{' '}
          {reconnectGraceSeconds === null
            ? 'Checking reconnect grace.'
            : `${formatSeconds(reconnectGraceSeconds)} of reconnect grace remain.`}
        </p>
        <div className="system-panel__actions">
          <button
            className="primary-action primary-action--compact"
            type="button"
            onClick={onFreshQuickplay}
          >
            <span>Fresh quickplay</span>
            <span aria-hidden="true">+</span>
          </button>
          <button className="text-action" type="button" onClick={onLeave}>
            Leave arena
          </button>
          <button className="text-action" type="button" onClick={onPlayLocal}>
            Play local
          </button>
        </div>
      </section>
    );
  }
  return (
    <OnlineFailurePanel
      hadSession={hadSession}
      onFreshQuickplay={onFreshQuickplay}
      onLeave={onLeave}
      onPlayLocal={onPlayLocal}
      onRetryOnline={onRetryOnline}
      onRetryRenderer={onRetryRenderer}
      status={status}
      unavailableReason={unavailableReason}
    />
  );
}

function OnlineFailurePanel({
  hadSession,
  onFreshQuickplay,
  onLeave,
  onPlayLocal,
  onRetryOnline,
  onRetryRenderer,
  status,
  unavailableReason,
}: {
  hadSession: boolean;
  onFreshQuickplay(): void;
  onLeave(): void;
  onPlayLocal(): void;
  onRetryOnline(): void;
  onRetryRenderer(): void;
  status: OnlineArenaStatus;
  unavailableReason: OnlineArenaUnavailableReason | null;
}) {
  const rendererFailure = status === 'unavailable' && unavailableReason === 'renderer';
  let title = 'Online service unavailable';
  let kicker = 'Public field / unavailable';
  let copy = hadSession
    ? 'The live connection ended. Retry the same ephemeral session, start fresh explicitly, or leave online play.'
    : 'Public quickplay could not connect. Local play remains ready without the online service.';
  if (rendererFailure) {
    title = 'Online renderer unavailable';
    kicker = 'Public field / render failure';
    copy = hadSession
      ? 'The shared arena remains live and your avatar is vulnerable. It could not pause; held controls were cleared and reconnect eligibility was retained.'
      : 'The arena view could not be created, so no online admission was started.';
  } else if (status === 'capacity') {
    title = 'Public arena capacity reached';
    kicker = 'Public field / capacity';
    copy =
      'All bounded public slots are in use. Retry online or start a fresh local run.';
  } else if (status === 'incompatible') {
    title = 'Online version incompatible';
    kicker = 'Public field / protocol';
    copy = 'This client and the online authority cannot safely share gameplay state.';
  } else if (status === 'draining') {
    title = 'Online service draining';
    kicker = 'Public field / planned shutdown';
    copy =
      'The authority is ending ephemeral sessions and is not accepting a continuity claim.';
  } else if (status === 'expired') {
    title = 'Arena session expired';
    kicker = 'Public field / grace ended';
    copy =
      'The former callsign and session statistics are gone. Fresh quickplay creates a new anonymous identity.';
  }

  return (
    <section
      className="system-panel system-panel--error online-state-panel"
      aria-labelledby="online-failure-title"
      role="alert"
    >
      <span className="system-kicker">{kicker}</span>
      <h1 id="online-failure-title">{title}</h1>
      <p>{copy}</p>
      <div className="system-panel__actions">
        {rendererFailure ? (
          <button
            className="primary-action primary-action--compact"
            type="button"
            onClick={onRetryRenderer}
          >
            <span>Retry renderer</span>
            <span aria-hidden="true">R</span>
          </button>
        ) : status === 'expired' ? (
          <button
            className="primary-action primary-action--compact"
            type="button"
            onClick={onFreshQuickplay}
          >
            <span>Fresh quickplay</span>
            <span aria-hidden="true">+</span>
          </button>
        ) : (
          <button
            className="primary-action primary-action--compact"
            type="button"
            onClick={onRetryOnline}
          >
            <span>Retry online</span>
            <span aria-hidden="true">R</span>
          </button>
        )}
        {status === 'unavailable' && !rendererFailure ? (
          <button className="text-action" type="button" onClick={onFreshQuickplay}>
            Fresh quickplay
          </button>
        ) : null}
        <button className="text-action" type="button" onClick={onLeave}>
          Leave arena
        </button>
        <button className="text-action" type="button" onClick={onPlayLocal}>
          Play local
        </button>
      </div>
    </section>
  );
}

function LoadingPanel() {
  return (
    <section
      className="system-panel system-panel--loading"
      aria-labelledby="loading-title"
    >
      <span className="system-kicker">Field system / boot</span>
      <h1 id="loading-title">Calibrating arena</h1>
      <div className="calibration-track" aria-hidden="true">
        <span />
      </div>
      <p>Mapping lanes, cover, and local render hardware.</p>
    </section>
  );
}

function ReadyPanel({
  online,
  onOnline,
  onStart,
}: {
  online: OnlineArenaConfig;
  onOnline(): void;
  onStart(): void;
}) {
  return (
    <section className="briefing-panel" aria-labelledby="briefing-title">
      <div className="briefing-panel__index" aria-hidden="true">
        01 / OPEN FIELD
      </div>
      <div className="briefing-panel__copy">
        <span className="system-kicker">Instant local arena</span>
        <h1 id="briefing-title">
          <span>Drop</span>
          <span>Zone</span>
        </h1>
        <p className="briefing-panel__lede">
          Ninety seconds. One signal. No lobby between you and the yard.
        </p>
        <button className="primary-action" type="button" onClick={onStart}>
          <span>Drop in</span>
          <span aria-hidden="true">//</span>
        </button>
        <p className="briefing-panel__fineprint">
          Local run / no account / instant reset
        </p>
        <div className="briefing-panel__online-entry">
          <button
            className="secondary-action"
            type="button"
            aria-describedby="online-entry-note"
            disabled={!online.enabled}
            onClick={onOnline}
          >
            Public quickplay
          </button>
          <p id="online-entry-note">
            {online.enabled
              ? 'Anonymous continuous FFA / up to 8 players'
              : online.reason}
          </p>
        </div>
      </div>

      <div className="briefing-panel__intel">
        <div className="objective-card">
          <span className="hud-label">Run order</span>
          <strong>Survive the signal</strong>
          <p>
            Clear contacts, chain eliminations, and reach extraction with your suit
            intact.
          </p>
        </div>
        <div className="control-grid" aria-label="Desktop controls">
          <div>
            <kbd>WASD</kbd>
            <span>Move</span>
          </div>
          <div>
            <kbd>Mouse 1</kbd>
            <span>Aim + fire</span>
          </div>
          <div>
            <kbd>Space</kbd>
            <span>Dash</span>
          </div>
          <div>
            <kbd>P / Esc</kbd>
            <span>Pause</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function PausedPanel({ onRestart, onResume }: { onRestart(): void; onResume(): void }) {
  return (
    <section
      className="system-panel system-panel--paused"
      aria-labelledby="paused-title"
    >
      <span className="system-kicker">Field hold</span>
      <h1 id="paused-title">Run paused</h1>
      <p>The clock and arena are frozen. Held fire has been cleared.</p>
      <div className="system-panel__actions">
        <button
          className="primary-action primary-action--compact"
          type="button"
          onClick={onResume}
        >
          <span>Resume run</span>
          <span aria-hidden="true">&gt;</span>
        </button>
        <button className="text-action" type="button" onClick={onRestart}>
          Restart run
        </button>
      </div>
    </section>
  );
}

function DebriefPanel({
  onRestart,
  snapshot,
}: {
  onRestart(): void;
  snapshot: ArenaHudSnapshot;
}) {
  const extracted = snapshot.status === 'extracted';
  const accuracy =
    snapshot.stats.shots === 0
      ? 0
      : Math.round((snapshot.stats.hits / snapshot.stats.shots) * 100);
  return (
    <section className="debrief-panel" aria-labelledby="debrief-title">
      <div className="debrief-panel__result">
        <span className="system-kicker">
          Run report / {extracted ? 'clear' : 'interrupted'}
        </span>
        <h1 id="debrief-title">{extracted ? 'Extraction complete' : 'Signal lost'}</h1>
        <p>
          {extracted
            ? 'The yard is clear. Your route stays open.'
            : 'The yard closed in. Reset the signal and take another route.'}
        </p>
      </div>
      <dl className="debrief-stats">
        <div>
          <dt>Score</dt>
          <dd>{snapshot.score.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt>Contacts cleared</dt>
          <dd>{snapshot.stats.eliminations}</dd>
        </div>
        <div>
          <dt>Accuracy</dt>
          <dd>{accuracy}%</dd>
        </div>
        <div>
          <dt>Integrity</dt>
          <dd>{Math.ceil(snapshot.health)}%</dd>
        </div>
      </dl>
      <button className="primary-action" type="button" onClick={onRestart}>
        <span>Drop again</span>
        <span aria-hidden="true">//</span>
      </button>
    </section>
  );
}

function UnavailablePanel({ onRetry }: { onRetry(): void }) {
  return (
    <section className="system-panel system-panel--error" aria-labelledby="error-title">
      <span className="system-kicker">Render line / offline</span>
      <h1 id="error-title">Renderer unavailable</h1>
      <p>
        The browser could not open the arena view. Your page is still responsive and no
        run was started.
      </p>
      <button
        className="primary-action primary-action--compact"
        type="button"
        onClick={onRetry}
      >
        <span>Retry renderer</span>
        <span aria-hidden="true">R</span>
      </button>
    </section>
  );
}

function formatClock(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`;
}

function formatSeconds(seconds: number): string {
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function createRunSeed(runNumber: number): number {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    return (values[0] ?? 1) || 1;
  }
  return Math.imul(runNumber + 1, 2_654_435_761) >>> 0;
}

function onlineConnectionLabel(
  status: OnlineArenaStatus,
  unavailableReason: OnlineArenaUnavailableReason | null,
): string {
  switch (status) {
    case 'connected':
      return 'Stable';
    case 'delayed':
      return 'Delayed';
    case 'reconnecting':
      return 'Reconnecting';
    case 'draining':
      return 'Draining';
    case 'connecting':
      return 'Connecting';
    case 'expired':
      return 'Expired';
    case 'incompatible':
      return 'Incompatible';
    case 'capacity':
      return 'Capacity full';
    case 'unavailable':
      return unavailableReason === 'renderer' ? 'Renderer failure' : 'Unavailable';
  }
}

function disposeDriverOnce(
  driver: ArenaRuntimeDriver | OnlineArenaRuntimeDriver | null,
  disposedDrivers: WeakSet<object>,
): void {
  if (!driver || disposedDrivers.has(driver)) return;
  disposedDrivers.add(driver);
  driver.dispose();
}
