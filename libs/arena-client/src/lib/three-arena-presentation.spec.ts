import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry } from 'three/src/core/BufferGeometry.js';
import { Material } from 'three/src/materials/Material.js';
import type { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';

import { createArenaState } from '@dropzone-arena/arena-engine';
import type {
  SnapshotEvent,
  SnapshotPlayer,
  SnapshotProjectile,
} from '@dropzone-arena/arena-protocol';

import { ThreeArenaPresentation } from './three-arena-presentation';

const presentations: ThreeArenaPresentation[] = [];

afterEach(() => {
  for (const presentation of presentations) presentation.dispose();
  presentations.length = 0;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ThreeArenaPresentation', () => {
  it('renders local state and disposes detached resources exactly once', () => {
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    const renderer = createRendererHarness();
    const presentation = createPresentation(renderer);
    const state = createArenaState(17);
    const stateWithGunner = {
      ...state,
      enemies: state.enemies.map((enemy, index) =>
        index === 0 ? { ...enemy, kind: 'gunner' as const } : enemy,
      ),
    };

    presentation.syncLocal(stateWithGunner);
    presentation.processLocalEvents([{ position: { x: 1, y: 2 }, type: 'dash' }]);
    presentation.render(1 / 60, 1);
    presentation.resetLocal();
    presentation.dispose();

    expect(renderer.render).toHaveBeenCalledOnce();
    expect(geometryDispose.mock.calls.length).toBeGreaterThan(0);
    expect(materialDispose.mock.calls.length).toBeGreaterThan(0);
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
    expect(renderer.canvas.isConnected).toBe(false);

    const disposedGeometryCount = geometryDispose.mock.calls.length;
    const disposedMaterialCount = materialDispose.mock.calls.length;
    presentation.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(disposedGeometryCount);
    expect(materialDispose).toHaveBeenCalledTimes(disposedMaterialCount);
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });

  it('owns capped DPR, resize, reduced motion, and context-loss lifecycle', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const disconnect = vi.fn<() => void>();
    const observe = vi.fn<(target: Element) => void>();
    class FakeResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}

      disconnect = disconnect;
      observe = observe;
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const renderer = createRendererHarness();
    const onContextLost = vi.fn<() => void>();
    const host = createHost(800, 450);
    const presentation = createPresentation(renderer, host, onContextLost);

    expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    expect(renderer.setSize).toHaveBeenLastCalledWith(800, 450, false);
    expect(observe).toHaveBeenCalledWith(host);
    presentation.setReducedMotion(true);
    expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1);

    setHostSize(host, 400, 700);
    globalThis.dispatchEvent(new Event('resize'));
    expect(renderer.setSize).toHaveBeenLastCalledWith(400, 700, false);

    const contextLoss = new Event('webglcontextlost', { cancelable: true });
    renderer.canvas.dispatchEvent(contextLoss);
    renderer.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(contextLoss.defaultPrevented).toBe(true);
    expect(onContextLost).toHaveBeenCalledOnce();

    const resizeCount = renderer.setSize.mock.calls.length;
    presentation.dispose();
    presentation.dispose();
    globalThis.dispatchEvent(new Event('resize'));
    renderer.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(renderer.setSize).toHaveBeenCalledTimes(resizeCount);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(onContextLost).toHaveBeenCalledOnce();
  });

  it('keeps stable numbered shape markers while capping online players and projectiles', () => {
    const renderer = createRendererHarness();
    const host = createHost(800, 450);
    const presentation = createPresentation(renderer, host);
    const local = createOnlinePlayer('player-local', 'LOCAL');
    const remotes = Array.from({ length: 9 }, (_, index) =>
      createOnlinePlayer(`player-${index + 1}`, `REMOTE ${index + 1}`, {
        position: { x: index - 4, y: index % 2 },
      }),
    );
    const projectiles = Array.from({ length: 110 }, (_, index) =>
      createOnlineProjectile(index),
    );

    presentation.syncOnline({
      localPlayer: local,
      projectiles,
      remotePlayers: remotes,
    });
    presentation.render(1 / 60, 1);
    const internals = presentation as unknown as {
      localPlayerPosition: { x: number; y: number } | null;
      onlinePlayerMeshes: Map<
        string,
        { body: { geometry: unknown; scale: { y: number } }; label: HTMLDivElement }
      >;
      onlineProjectileMeshes: Map<number, unknown>;
    };

    expect(internals.onlinePlayerMeshes.size).toBe(8);
    expect(internals.onlineProjectileMeshes.size).toBe(96);
    expect(internals.localPlayerPosition).toEqual(local.position);
    const labels = [...host.querySelectorAll<HTMLElement>('.arena-online-marker')];
    expect(labels).toHaveLength(8);
    expect(labels.every((label) => label.getAttribute('aria-hidden') === 'true')).toBe(
      true,
    );
    expect(labels.some((label) => label.textContent?.includes('LOCAL | YOU'))).toBe(
      true,
    );
    const firstMarkers = new Map(
      [local, ...remotes.slice(0, 7)].map((player) => [
        player.id,
        presentation.getOnlineMarker(player.id),
      ]),
    );
    const firstBody = internals.onlinePlayerMeshes.get(local.id)?.body;
    const secondBody = internals.onlinePlayerMeshes.get(remotes[0]?.id ?? '')?.body;
    expect(firstBody?.geometry).not.toBe(secondBody?.geometry);

    const removed = remotes[1];
    if (!removed) throw new Error('Expected remote fixture');
    const removedLabel = internals.onlinePlayerMeshes.get(removed.id)?.label;
    const nextRemotes = [
      ...remotes
        .slice(0, 7)
        .filter((player) => player.id !== removed.id)
        .reverse(),
      remotes[7],
    ].filter((player): player is SnapshotPlayer => player !== undefined);
    presentation.syncOnline({
      localPlayer: local,
      projectiles: projectiles.slice(0, 2),
      remotePlayers: nextRemotes,
    });

    const stablePlayers = [local, ...nextRemotes.slice(0, 6)].filter((player) =>
      firstMarkers.has(player.id),
    );
    expect(
      stablePlayers.map((player) => presentation.getOnlineMarker(player.id)),
    ).toEqual(stablePlayers.map((player) => firstMarkers.get(player.id)));
    expect(presentation.getOnlineMarker(remotes[7]?.id ?? '')).toBe(
      firstMarkers.get(removed.id),
    );
    expect(removedLabel?.isConnected).toBe(false);
    expect(internals.onlineProjectileMeshes.size).toBe(2);

    const retainedLocalMarker = presentation.getOnlineMarker(local.id);
    presentation.resetOnline(true);
    presentation.syncOnline({
      localPlayer: local,
      projectiles: [],
      remotePlayers: nextRemotes,
    });
    expect(presentation.getOnlineMarker(local.id)).toBe(retainedLocalMarker);

    presentation.resetOnline();
    expect(host.querySelectorAll('.arena-online-marker')).toHaveLength(0);
    expect(internals.onlinePlayerMeshes.size).toBe(0);
    expect(internals.onlineProjectileMeshes.size).toBe(0);
  });

  it('renders authoritative online transitions, local muzzle-only feedback, and reduced effects', () => {
    const host = createHost(640, 360);
    const presentation = createPresentation(createRendererHarness(), host);
    const local = createOnlinePlayer('player-local', 'LOCAL');
    const eliminated = createOnlinePlayer('player-remote', 'REMOTE', {
      health: 0,
      respawnTicks: 180,
      status: 'eliminated',
    });
    presentation.syncOnline({
      localPlayer: local,
      projectiles: [],
      remotePlayers: [eliminated],
    });
    const internals = presentation as unknown as {
      onlinePlayerMeshes: Map<
        string,
        { body: { scale: { y: number } }; label: HTMLDivElement }
      >;
      onlineProjectileMeshes: Map<number, unknown>;
      particles: unknown[];
    };
    expect(internals.onlinePlayerMeshes.get(eliminated.id)?.body.scale.y).toBe(0.16);
    expect(
      internals.onlinePlayerMeshes.get(eliminated.id)?.label.textContent,
    ).toContain('OUT');

    presentation.showLocalMuzzleFeedback(local);
    expect(internals.particles).toHaveLength(1);
    expect(internals.onlineProjectileMeshes.size).toBe(0);

    const events = createOnlineEvents();
    presentation.processOnlineEvents(events, local.id);
    expect(internals.particles.length).toBeGreaterThan(1);
    expect(internals.onlinePlayerMeshes.has(eliminated.id)).toBe(false);
    expect(host.textContent).not.toContain('REMOTE');

    presentation.setReducedMotion(true);
    expect(internals.particles).toHaveLength(0);
    for (let index = 0; index < 40; index += 1) {
      presentation.processOnlineEvents(
        [
          {
            damage: 25,
            ownerId: 'player-remote',
            projectileId: index,
            targetId: local.id,
            tick: index,
            type: 'hit',
            x: 0,
            y: 0,
          },
        ],
        local.id,
      );
    }
    expect(internals.particles.length).toBeLessThanOrEqual(24);

    presentation.syncOnline({
      localPlayer: local,
      projectiles: [createOnlineProjectile(1)],
      remotePlayers: [],
    });
    expect(internals.onlineProjectileMeshes.size).toBe(1);
    presentation.dispose();
    presentation.dispose();
    expect(host.querySelectorAll('.arena-online-marker')).toHaveLength(0);
  });
});

function createPresentation(
  renderer = createRendererHarness(),
  host = createHost(640, 360),
  onContextLost = vi.fn<() => void>(),
) {
  const presentation = new ThreeArenaPresentation({
    createRenderer: () => renderer.renderer,
    host,
    onContextLost,
    reducedMotion: false,
  });
  presentations.push(presentation);
  return presentation;
}

function createHost(width: number, height: number) {
  const host = document.createElement('div');
  setHostSize(host, width, height);
  document.body.append(host);
  return host;
}

function setHostSize(host: HTMLElement, width: number, height: number) {
  Object.defineProperties(host, {
    clientHeight: { configurable: true, value: height },
    clientWidth: { configurable: true, value: width },
  });
}

function createRendererHarness() {
  const canvas = document.createElement('canvas');
  const dispose = vi.fn<() => void>();
  const forceContextLoss = vi.fn<() => void>();
  const render = vi.fn<(...args: unknown[]) => void>();
  const setPixelRatio = vi.fn<(value: number) => void>();
  const setSize =
    vi.fn<(width: number, height: number, updateStyle?: boolean) => void>();
  const renderer = {
    dispose,
    domElement: canvas,
    forceContextLoss,
    outputColorSpace: '',
    render,
    setPixelRatio,
    setSize,
    shadowMap: { enabled: false, type: 0 },
    toneMapping: 0,
    toneMappingExposure: 1,
  } as unknown as WebGLRenderer;
  return {
    canvas,
    dispose,
    forceContextLoss,
    render,
    renderer,
    setPixelRatio,
    setSize,
  };
}

function createOnlinePlayer(
  id: string,
  callsign: string,
  overrides: Partial<SnapshotPlayer> = {},
): SnapshotPlayer {
  return {
    aim: { x: 0, y: -1 },
    callsign,
    dashCooldownTicks: 0,
    dashTicks: 0,
    fireCooldownTicks: 0,
    health: 100,
    id,
    lastProcessedInputSequence: 0,
    position: { x: 0, y: 0 },
    radius: 0.48,
    respawnTicks: 0,
    spawnProtectionTicks: 0,
    statistics: { deaths: 0, kills: 0 },
    status: 'alive',
    velocity: { x: 0, y: 0 },
    ...overrides,
  };
}

function createOnlineProjectile(id: number): SnapshotProjectile {
  return {
    id,
    ownerId: 'player-remote',
    vx: 1,
    vy: 0,
    x: id / 10,
    y: 0,
  };
}

function createOnlineEvents(): SnapshotEvent[] {
  return [
    { playerId: 'player-local', tick: 1, type: 'dash', x: 0, y: 0 },
    {
      ownerId: 'player-local',
      projectileId: 1,
      tick: 2,
      type: 'shot',
      x: 0,
      y: 0,
    },
    {
      damage: 25,
      ownerId: 'player-remote',
      projectileId: 2,
      targetId: 'player-local',
      tick: 3,
      type: 'hit',
      x: 0,
      y: 0,
    },
    {
      killerId: 'player-local',
      projectileId: 3,
      tick: 4,
      type: 'player-eliminated',
      victimId: 'player-remote',
      x: 1,
      y: 1,
    },
    { playerId: 'player-local', tick: 5, type: 'player-respawned', x: 0, y: 0 },
    { playerId: 'player-new', tick: 6, type: 'player-joined', x: 2, y: 2 },
    { playerId: 'player-remote', tick: 7, type: 'player-left' },
  ];
}
