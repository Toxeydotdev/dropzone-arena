import { PerspectiveCamera } from 'three/src/cameras/PerspectiveCamera.js';
import {
  ACESFilmicToneMapping,
  DoubleSide,
  PCFSoftShadowMap,
  SRGBColorSpace,
} from 'three/src/constants.js';
import { BufferGeometry } from 'three/src/core/BufferGeometry.js';
import { Raycaster } from 'three/src/core/Raycaster.js';
import { BoxGeometry } from 'three/src/geometries/BoxGeometry.js';
import { ConeGeometry } from 'three/src/geometries/ConeGeometry.js';
import { CylinderGeometry } from 'three/src/geometries/CylinderGeometry.js';
import { DodecahedronGeometry } from 'three/src/geometries/DodecahedronGeometry.js';
import { OctahedronGeometry } from 'three/src/geometries/OctahedronGeometry.js';
import { PlaneGeometry } from 'three/src/geometries/PlaneGeometry.js';
import { RingGeometry } from 'three/src/geometries/RingGeometry.js';
import { SphereGeometry } from 'three/src/geometries/SphereGeometry.js';
import { TetrahedronGeometry } from 'three/src/geometries/TetrahedronGeometry.js';
import { TorusGeometry } from 'three/src/geometries/TorusGeometry.js';
import { GridHelper } from 'three/src/helpers/GridHelper.js';
import { DirectionalLight } from 'three/src/lights/DirectionalLight.js';
import { HemisphereLight } from 'three/src/lights/HemisphereLight.js';
import { PointLight } from 'three/src/lights/PointLight.js';
import { Material } from 'three/src/materials/Material.js';
import { MeshBasicMaterial } from 'three/src/materials/MeshBasicMaterial.js';
import { MeshStandardMaterial } from 'three/src/materials/MeshStandardMaterial.js';
import { Color } from 'three/src/math/Color.js';
import { Plane } from 'three/src/math/Plane.js';
import { Vector2 as ThreeVector2 } from 'three/src/math/Vector2.js';
import { Vector3 } from 'three/src/math/Vector3.js';
import { Group } from 'three/src/objects/Group.js';
import { Mesh } from 'three/src/objects/Mesh.js';
import { FogExp2 } from 'three/src/scenes/FogExp2.js';
import { Scene } from 'three/src/scenes/Scene.js';
import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';
import type { Object3D } from 'three/src/core/Object3D.js';
import type { Line } from 'three/src/objects/Line.js';
import type { Points } from 'three/src/objects/Points.js';

import {
  ARENA_HALF_SIZE,
  ARENA_OBSTACLES,
  type ArenaEvent,
  type ArenaState,
  type EnemyState,
  type PickupState,
  type ProjectileState,
  type Vector2,
} from '@dropzone-arena/arena-engine';
import type {
  SnapshotEvent,
  SnapshotPlayer,
  SnapshotProjectile,
} from '@dropzone-arena/arena-protocol';

const MAX_ONLINE_REMOTE_PLAYERS = 7;
const MAX_ONLINE_PROJECTILES = 96;
const MAX_ONLINE_MARKERS = 8;
const MAX_PARTICLES = 128;
const MAX_REDUCED_MOTION_PARTICLES = 24;
const ONLINE_PLAYER_COLORS = [
  0xd7ff3f, 0x77d9ff, 0xff765f, 0xf1d36a, 0xa7a3ff, 0x65deb4, 0xff9cce, 0xd9d6c7,
] as const;

const THREE = {
  ACESFilmicToneMapping,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  DoubleSide,
  FogExp2,
  GridHelper,
  Group,
  HemisphereLight,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PointLight,
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TetrahedronGeometry,
  TorusGeometry,
  Vector2: ThreeVector2,
  Vector3,
  WebGLRenderer,
};

interface Particle {
  life: number;
  maxLife: number;
  mesh: Mesh;
  spin: Vector2;
  velocity: Vector3;
}

interface OnlinePlayerVisual {
  body: Mesh;
  group: Group;
  label: HTMLDivElement;
  marker: number;
}

export interface OnlineArenaPresentationFrame {
  localPlayer: SnapshotPlayer | null;
  projectiles: readonly SnapshotProjectile[];
  remotePlayers: readonly SnapshotPlayer[];
}

export interface ThreeArenaPresentationOptions {
  createRenderer?(): WebGLRenderer;
  host: HTMLElement;
  onContextLost(): void;
  reducedMotion: boolean;
}

export class ThreeArenaPresentation {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(46, 1, 0.1, 120);
  private renderer: WebGLRenderer | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly aimIntersection = new THREE.Vector3();
  private readonly labelProjection = new THREE.Vector3();
  private readonly enemyMeshes = new Map<number, Group>();
  private readonly projectileMeshes = new Map<number, Mesh>();
  private readonly pickupMeshes = new Map<number, Group>();
  private readonly onlinePlayerMeshes = new Map<string, OnlinePlayerVisual>();
  private readonly onlineProjectileMeshes = new Map<number, Mesh>();
  private readonly onlineMarkerByPlayerId = new Map<string, number>();
  private readonly particles: Particle[] = [];
  private readonly geometries = new Set<BufferGeometry>();
  private readonly materials = new Set<Material>();

  private readonly runnerGeometry = this.trackGeometry(
    new THREE.OctahedronGeometry(0.48, 0),
  );
  private readonly gunnerGeometry = this.trackGeometry(
    new THREE.CylinderGeometry(0.43, 0.54, 0.7, 8),
  );
  private readonly bruteGeometry = this.trackGeometry(
    new THREE.DodecahedronGeometry(0.72, 0),
  );
  private readonly enemyRingGeometry = this.trackGeometry(
    new THREE.TorusGeometry(0.62, 0.035, 5, 20),
  );
  private readonly gunnerBarrelGeometry = this.trackGeometry(
    new THREE.BoxGeometry(0.12, 0.12, 0.62),
  );
  private readonly projectileGeometry = this.trackGeometry(
    new THREE.SphereGeometry(0.14, 8, 6),
  );
  private readonly pickupGeometry = this.trackGeometry(
    new THREE.OctahedronGeometry(0.33, 0),
  );
  private readonly pickupRingGeometry = this.trackGeometry(
    new THREE.TorusGeometry(0.5, 0.035, 6, 24),
  );
  private readonly particleGeometry = this.trackGeometry(
    new THREE.TetrahedronGeometry(0.11, 0),
  );
  private readonly onlinePlayerGeometries = [
    this.trackGeometry(new THREE.CylinderGeometry(0.42, 0.52, 0.62, 8)),
    this.trackGeometry(new THREE.BoxGeometry(0.76, 0.68, 0.76)),
    this.trackGeometry(new THREE.OctahedronGeometry(0.56, 0)),
    this.trackGeometry(new THREE.DodecahedronGeometry(0.54, 0)),
  ] as const;
  private readonly onlineMarkerGeometry = this.trackGeometry(
    new THREE.RingGeometry(0.58, 0.69, 24),
  );

  private readonly playerMaterial = this.trackMaterial(
    new THREE.MeshStandardMaterial({
      color: 0xd7ff3f,
      emissive: 0x5d7612,
      emissiveIntensity: 0.5,
      metalness: 0.24,
      roughness: 0.46,
    }),
  );
  private readonly playerDarkMaterial = this.trackMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x101816,
      emissive: 0x223226,
      emissiveIntensity: 0.25,
      metalness: 0.58,
      roughness: 0.38,
    }),
  );
  private readonly runnerMaterial = this.trackMaterial(
    new THREE.MeshStandardMaterial({
      color: 0xff5b45,
      emissive: 0x6f1711,
      emissiveIntensity: 0.62,
      metalness: 0.16,
      roughness: 0.54,
    }),
  );
  private readonly gunnerMaterial = this.trackMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x77d9ff,
      emissive: 0x144b60,
      emissiveIntensity: 0.56,
      metalness: 0.28,
      roughness: 0.42,
    }),
  );
  private readonly bruteMaterial = this.trackMaterial(
    new THREE.MeshStandardMaterial({
      color: 0xd9d6c7,
      emissive: 0x4c1d17,
      emissiveIntensity: 0.3,
      metalness: 0.48,
      roughness: 0.52,
    }),
  );
  private readonly hostileProjectileMaterial = this.trackMaterial(
    new THREE.MeshBasicMaterial({ color: 0xff5b45 }),
  );
  private readonly playerProjectileMaterial = this.trackMaterial(
    new THREE.MeshBasicMaterial({ color: 0xd7ff3f }),
  );
  private readonly repairMaterial = this.trackMaterial(
    new THREE.MeshStandardMaterial({
      color: 0xd7ff3f,
      emissive: 0x658219,
      emissiveIntensity: 0.9,
      roughness: 0.35,
    }),
  );
  private readonly overdriveMaterial = this.trackMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x77d9ff,
      emissive: 0x16586d,
      emissiveIntensity: 0.95,
      roughness: 0.3,
    }),
  );
  private readonly coralParticleMaterial = this.trackMaterial(
    new THREE.MeshBasicMaterial({ color: 0xff5b45 }),
  );
  private readonly limeParticleMaterial = this.trackMaterial(
    new THREE.MeshBasicMaterial({ color: 0xd7ff3f }),
  );
  private readonly blueParticleMaterial = this.trackMaterial(
    new THREE.MeshBasicMaterial({ color: 0x77d9ff }),
  );
  private readonly onlinePlayerMaterials = ONLINE_PLAYER_COLORS.map((color) =>
    this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.22,
        metalness: 0.24,
        roughness: 0.5,
      }),
    ),
  );
  private readonly onlineMarkerMaterials = ONLINE_PLAYER_COLORS.map((color) =>
    this.trackMaterial(
      new THREE.MeshBasicMaterial({
        color,
        opacity: 0.68,
        side: THREE.DoubleSide,
        transparent: true,
      }),
    ),
  );

  private readonly playerMesh: Group;
  private readonly playerCore: Mesh;
  private readonly onlineMarkerLayer: HTMLDivElement;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private contextLost = false;
  private reducedMotion: boolean;
  private localPlayerPosition: Vector2 | null = null;
  private cameraShake = 0;
  private viewportAspect = 16 / 9;
  private presentationMode: 'local' | 'none' | 'online' = 'none';

  constructor(private readonly options: ThreeArenaPresentationOptions) {
    this.reducedMotion = options.reducedMotion;
    this.onlineMarkerLayer = document.createElement('div');
    this.onlineMarkerLayer.className = 'arena-online-markers';
    this.onlineMarkerLayer.setAttribute('aria-hidden', 'true');
    Object.assign(this.onlineMarkerLayer.style, {
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
      position: 'absolute',
    });
    try {
      this.renderer =
        options.createRenderer?.() ??
        new THREE.WebGLRenderer({
          antialias: true,
          alpha: false,
          powerPreference: 'high-performance',
        });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.08;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.domElement.setAttribute('role', 'img');
      this.renderer.domElement.setAttribute(
        'aria-label',
        'Top-down arena view. Run status and controls are available around the arena.',
      );
      this.renderer.domElement.addEventListener(
        'webglcontextlost',
        this.handleContextLost,
      );
      this.options.host.append(this.renderer.domElement);
      this.options.host.append(this.onlineMarkerLayer);

      this.scene.background = new THREE.Color(0x080b0b);
      this.scene.fog = new THREE.FogExp2(0x080b0b, 0.022);
      this.playerMesh = this.createPlayerMesh();
      const core = this.playerMesh.getObjectByName('player-core');
      if (!(core instanceof THREE.Mesh)) {
        throw new Error('Player mesh was not created.');
      }
      this.playerCore = core;
      this.playerMesh.visible = false;
      this.addToScene(this.playerMesh);

      this.createArenaScene();
      this.resize();
      if (typeof ResizeObserver === 'function') {
        this.resizeObserver = new ResizeObserver(this.resize);
        this.resizeObserver.observe(this.options.host);
      }
      globalThis.addEventListener('resize', this.resize);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get canvas(): HTMLCanvasElement {
    const renderer = this.renderer;
    if (!renderer) throw new Error('Arena presentation is disposed.');
    return renderer.domElement;
  }

  getOnlineMarker(playerId: string): number | null {
    return this.onlineMarkerByPlayerId.get(playerId) ?? null;
  }

  processLocalEvents(events: readonly ArenaEvent[]): void {
    if (!this.disposed) this.processEvents(events);
  }

  processOnlineEvents(events: readonly SnapshotEvent[], localPlayerId: string): void {
    if (!this.disposed) this.processAuthoritativeOnlineEvents(events, localPlayerId);
  }

  showLocalMuzzleFeedback(player: SnapshotPlayer): void {
    if (this.disposed || player.status !== 'alive') return;
    this.spawnBurst(
      {
        x: player.position.x + player.aim.x * (player.radius + 0.18),
        y: player.position.y + player.aim.y * (player.radius + 0.18),
      },
      this.limeParticleMaterial,
      hashString(player.id) ^ 0x51,
      1,
    );
  }

  projectPointerAim(
    clientX: number,
    clientY: number,
    origin: Vector2,
    fallback: Vector2,
  ): Vector2 {
    const renderer = this.renderer;
    if (!renderer || this.disposed) return fallback;
    const bounds = renderer.domElement.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return fallback;
    const normalized = new THREE.Vector2(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      -((clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(normalized, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.aimPlane, this.aimIntersection)) {
      return fallback;
    }
    return normalizeVector(
      {
        x: this.aimIntersection.x - origin.x,
        y: this.aimIntersection.z - origin.y,
      },
      fallback,
    );
  }

  render(deltaSeconds: number, elapsedSeconds: number): void {
    const renderer = this.renderer;
    if (!renderer || this.disposed || this.contextLost) return;
    this.updateParticles(deltaSeconds);
    this.updateCamera(deltaSeconds, elapsedSeconds);
    this.updateOnlineLabels();
    renderer.render(this.scene, this.camera);
  }

  resetLocal(): void {
    if (this.disposed) return;
    this.clearLocalDynamicScene();
    this.localPlayerPosition = null;
    this.playerMesh.visible = false;
    if (this.presentationMode === 'local') this.presentationMode = 'none';
  }

  resetOnline(retainMarkers = false): void {
    if (this.disposed) return;
    this.clearOnlineScene(retainMarkers);
    this.localPlayerPosition = null;
    if (this.presentationMode === 'online') this.presentationMode = 'none';
  }

  setReducedMotion(reducedMotion: boolean): void {
    if (this.disposed) return;
    this.reducedMotion = reducedMotion;
    this.renderer?.setPixelRatio(this.pixelRatio());
    if (reducedMotion) {
      this.cameraShake = 0;
      this.clearParticles();
    }
  }

  syncLocal(state: ArenaState): void {
    if (this.disposed) return;
    if (this.presentationMode !== 'local') {
      this.clearOnlineScene();
      this.clearLocalDynamicScene();
      this.presentationMode = 'local';
    }
    this.localPlayerPosition = { ...state.player.position };
    this.playerMesh.visible = true;
    this.syncScene(state);
  }

  syncOnline(frame: OnlineArenaPresentationFrame): void {
    if (this.disposed) return;
    if (this.presentationMode !== 'online') {
      if (this.presentationMode === 'local') this.clearLocalDynamicScene();
      this.playerMesh.visible = false;
      this.presentationMode = 'online';
    }

    const localPlayer = frame.localPlayer;
    this.localPlayerPosition = localPlayer ? { ...localPlayer.position } : null;
    const seenPlayerIds = new Set<string>();
    const players: SnapshotPlayer[] = [];
    if (localPlayer) {
      seenPlayerIds.add(localPlayer.id);
      players.push(localPlayer);
    }
    for (const player of frame.remotePlayers) {
      if (
        seenPlayerIds.has(player.id) ||
        players.length >= MAX_ONLINE_REMOTE_PLAYERS + (localPlayer ? 1 : 0)
      ) {
        continue;
      }
      seenPlayerIds.add(player.id);
      players.push(player);
    }

    const livePlayerIds = new Set<string>();
    for (const player of players) livePlayerIds.add(player.id);
    this.removeMissingOnlinePlayers(livePlayerIds);
    for (const player of players) {
      let visual = this.onlinePlayerMeshes.get(player.id);
      if (!visual) {
        const marker = this.allocateOnlineMarker(player.id);
        if (marker === null) continue;
        visual = this.createOnlinePlayerVisual(player, marker);
        this.onlinePlayerMeshes.set(player.id, visual);
        this.addToScene(visual.group);
        this.onlineMarkerLayer.append(visual.label);
      }
      this.syncOnlinePlayerVisual(visual, player, player.id === localPlayer?.id);
    }

    const liveProjectileIds = new Set<number>();
    for (const projectile of frame.projectiles.slice(0, MAX_ONLINE_PROJECTILES)) {
      liveProjectileIds.add(projectile.id);
      let mesh = this.onlineProjectileMeshes.get(projectile.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          this.projectileGeometry,
          projectile.ownerId === localPlayer?.id
            ? this.playerProjectileMaterial
            : this.hostileProjectileMaterial,
        );
        this.onlineProjectileMeshes.set(projectile.id, mesh);
        this.addToScene(mesh);
      }
      mesh.position.set(projectile.x, 0.46, projectile.y);
      mesh.scale.set(0.9, 0.9, 1.65);
      mesh.rotation.y = Math.atan2(-projectile.vx, -projectile.vy);
    }
    this.removeMissing(this.onlineProjectileMeshes, liveProjectileIds);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    globalThis.removeEventListener('resize', this.resize);
    const renderer = this.renderer;
    this.renderer = null;
    renderer?.domElement.removeEventListener(
      'webglcontextlost',
      this.handleContextLost,
    );

    this.trackObjectResources(this.scene);
    this.scene.clear();
    this.enemyMeshes.clear();
    this.projectileMeshes.clear();
    this.pickupMeshes.clear();
    this.onlinePlayerMeshes.clear();
    this.onlineProjectileMeshes.clear();
    this.onlineMarkerByPlayerId.clear();
    this.particles.length = 0;
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.clear();
    this.materials.clear();
    renderer?.dispose();
    renderer?.forceContextLoss();
    renderer?.domElement.remove();
    this.onlineMarkerLayer.remove();
  }

  private createArenaScene(): void {
    const hemisphere = new THREE.HemisphereLight(0xc9e7dc, 0x17221d, 1.15);
    this.addToScene(hemisphere);

    const key = new THREE.DirectionalLight(0xf2f4dc, 2.7);
    key.position.set(-8, 18, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -14;
    key.shadow.camera.right = 14;
    key.shadow.camera.top = 14;
    key.shadow.camera.bottom = -14;
    this.addToScene(key);

    const coralLight = new THREE.PointLight(0xff5b45, 16, 11, 2);
    coralLight.position.set(10, 2.8, -10);
    this.addToScene(coralLight);
    const blueLight = new THREE.PointLight(0x77d9ff, 13, 10, 2);
    blueLight.position.set(-10, 2.6, 10);
    this.addToScene(blueLight);

    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x101714,
      metalness: 0.08,
      roughness: 0.92,
    });
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_HALF_SIZE * 2, ARENA_HALF_SIZE * 2),
      floorMaterial,
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.addToScene(floor);

    const underlay = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_HALF_SIZE * 2 + 8, ARENA_HALF_SIZE * 2 + 8),
      new THREE.MeshStandardMaterial({ color: 0x060808, roughness: 1 }),
    );
    underlay.rotation.x = -Math.PI / 2;
    underlay.position.y = -0.08;
    this.addToScene(underlay);

    const grid = new THREE.GridHelper(ARENA_HALF_SIZE * 2, 24, 0x43554a, 0x26322c);
    grid.position.y = 0.015;
    const gridMaterials = Array.isArray(grid.material)
      ? grid.material
      : [grid.material];
    for (const material of gridMaterials) {
      material.transparent = true;
      material.opacity = 0.36;
    }
    this.addToScene(grid);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xd7ff3f,
      opacity: 0.33,
      side: THREE.DoubleSide,
      transparent: true,
    });
    for (const radius of [2.6, 7.2]) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius - 0.035, radius + 0.035, 72),
        ringMaterial,
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.024;
      this.addToScene(ring);
    }

    const laneMaterial = new THREE.MeshBasicMaterial({
      color: 0xe7eadc,
      opacity: 0.2,
      transparent: true,
    });
    for (const x of [-8, 0, 8]) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.055, 19), laneMaterial);
      line.rotation.x = -Math.PI / 2;
      line.position.set(x, 0.026, 0);
      this.addToScene(line);
    }

    const railMaterial = new THREE.MeshStandardMaterial({
      color: 0x1f2a25,
      emissive: 0x162019,
      emissiveIntensity: 0.28,
      metalness: 0.5,
      roughness: 0.55,
    });
    this.addBox(
      ARENA_HALF_SIZE * 2 + 1,
      0.7,
      0.4,
      railMaterial,
      0,
      0.34,
      -ARENA_HALF_SIZE - 0.2,
    );
    this.addBox(
      ARENA_HALF_SIZE * 2 + 1,
      0.7,
      0.4,
      railMaterial,
      0,
      0.34,
      ARENA_HALF_SIZE + 0.2,
    );
    this.addBox(
      0.4,
      0.7,
      ARENA_HALF_SIZE * 2 + 1,
      railMaterial,
      -ARENA_HALF_SIZE - 0.2,
      0.34,
      0,
    );
    this.addBox(
      0.4,
      0.7,
      ARENA_HALF_SIZE * 2 + 1,
      railMaterial,
      ARENA_HALF_SIZE + 0.2,
      0.34,
      0,
    );

    const hazardMaterial = new THREE.MeshStandardMaterial({
      color: 0x333a31,
      emissive: 0x726d14,
      emissiveIntensity: 0.22,
      metalness: 0.34,
      roughness: 0.62,
    });
    for (const obstacle of ARENA_OBSTACLES) {
      this.addBox(
        obstacle.halfWidth * 2,
        0.9,
        obstacle.halfHeight * 2,
        hazardMaterial,
        obstacle.x,
        0.45,
        obstacle.y,
        true,
      );
      const marker = new THREE.Mesh(
        new THREE.PlaneGeometry(obstacle.halfWidth * 1.7, obstacle.halfHeight * 1.7),
        new THREE.MeshBasicMaterial({
          color: 0xd7ff3f,
          opacity: 0.24,
          transparent: true,
        }),
      );
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(obstacle.x, 0.91, obstacle.y);
      this.addToScene(marker);
    }

    const gateGeometry = new THREE.BoxGeometry(1.8, 0.12, 0.42);
    const gateMaterial = new THREE.MeshBasicMaterial({ color: 0xff5b45 });
    for (const [x, z, yaw] of [
      [0, -ARENA_HALF_SIZE + 0.35, 0],
      [ARENA_HALF_SIZE - 0.35, 0, Math.PI / 2],
      [0, ARENA_HALF_SIZE - 0.35, 0],
      [-ARENA_HALF_SIZE + 0.35, 0, Math.PI / 2],
    ] as const) {
      const gate = new THREE.Mesh(gateGeometry, gateMaterial);
      gate.position.set(x, 0.08, z);
      gate.rotation.y = yaw;
      this.addToScene(gate);
    }
  }

  private createPlayerMesh(): Group {
    const group = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.5, 0.48, 8),
      this.playerMaterial,
    );
    base.name = 'player-core';
    base.position.y = 0.36;
    base.castShadow = true;
    group.add(base);

    const shoulder = new THREE.Mesh(
      new THREE.TorusGeometry(0.36, 0.06, 6, 20),
      this.playerDarkMaterial,
    );
    shoulder.rotation.x = Math.PI / 2;
    shoulder.position.y = 0.63;
    group.add(shoulder);

    const barrel = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.16, 0.72),
      this.playerDarkMaterial,
    );
    barrel.position.set(0, 0.54, -0.46);
    barrel.castShadow = true;
    group.add(barrel);

    const direction = new THREE.Mesh(
      new THREE.ConeGeometry(0.13, 0.34, 5),
      this.playerMaterial,
    );
    direction.rotation.x = -Math.PI / 2;
    direction.position.set(0, 0.13, -0.88);
    group.add(direction);
    return group;
  }

  private createOnlinePlayerVisual(
    player: SnapshotPlayer,
    marker: number,
  ): OnlinePlayerVisual {
    const group = new THREE.Group();
    const geometry =
      this.onlinePlayerGeometries[(marker - 1) % this.onlinePlayerGeometries.length] ??
      this.onlinePlayerGeometries[0];
    const material =
      this.onlinePlayerMaterials[(marker - 1) % this.onlinePlayerMaterials.length] ??
      this.playerMaterial;
    const body = new THREE.Mesh(geometry, material);
    body.position.y = 0.46;
    body.castShadow = true;
    group.add(body);

    const direction = new THREE.Mesh(
      this.gunnerBarrelGeometry,
      this.playerDarkMaterial,
    );
    direction.position.set(0, 0.45, -0.48);
    group.add(direction);

    const markerMaterial =
      this.onlineMarkerMaterials[(marker - 1) % this.onlineMarkerMaterials.length] ??
      this.playerProjectileMaterial;
    const groundMarker = new THREE.Mesh(this.onlineMarkerGeometry, markerMaterial);
    groundMarker.rotation.x = -Math.PI / 2;
    groundMarker.position.y = 0.035;
    group.add(groundMarker);

    const label = document.createElement('div');
    label.className = 'arena-online-marker';
    label.setAttribute('aria-hidden', 'true');
    Object.assign(label.style, {
      background: 'rgba(8, 11, 11, 0.82)',
      border: `1px solid #${material.color.getHexString()}`,
      color: '#f0f2e8',
      font: '700 11px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace',
      left: '0',
      maxWidth: '144px',
      overflow: 'hidden',
      padding: '2px 5px',
      position: 'absolute',
      textOverflow: 'ellipsis',
      top: '0',
      transform: 'translate(-50%, -100%)',
      whiteSpace: 'nowrap',
      willChange: 'transform',
    });
    label.textContent = `#${marker} ${player.callsign}`;
    return { body, group, label, marker };
  }

  private syncOnlinePlayerVisual(
    visual: OnlinePlayerVisual,
    player: SnapshotPlayer,
    local: boolean,
  ): void {
    visual.group.position.set(player.position.x, 0, player.position.y);
    visual.group.rotation.y = Math.atan2(-player.aim.x, -player.aim.y);
    const eliminated = player.status === 'eliminated';
    visual.body.scale.set(1, eliminated ? 0.16 : player.dashTicks > 0 ? 0.68 : 1, 1);
    visual.body.position.y = eliminated ? 0.13 : 0.46;
    visual.label.style.opacity = eliminated ? '0.68' : '1';
    visual.label.textContent = `#${visual.marker} ${player.callsign}${local ? ' | YOU' : ''}${eliminated ? ' | OUT' : ''}`;
  }

  private allocateOnlineMarker(playerId: string): number | null {
    const existing = this.onlineMarkerByPlayerId.get(playerId);
    if (existing !== undefined) return existing;
    const used = new Set(this.onlineMarkerByPlayerId.values());
    for (let marker = 1; marker <= MAX_ONLINE_MARKERS; marker += 1) {
      if (used.has(marker)) continue;
      this.onlineMarkerByPlayerId.set(playerId, marker);
      return marker;
    }
    return null;
  }

  private removeMissingOnlinePlayers(livePlayerIds: Set<string>): void {
    for (const [playerId, visual] of this.onlinePlayerMeshes) {
      if (livePlayerIds.has(playerId)) continue;
      visual.group.removeFromParent();
      visual.label.remove();
      this.onlinePlayerMeshes.delete(playerId);
      this.onlineMarkerByPlayerId.delete(playerId);
    }
    for (const playerId of this.onlineMarkerByPlayerId.keys()) {
      if (!livePlayerIds.has(playerId)) this.onlineMarkerByPlayerId.delete(playerId);
    }
  }

  private createEnemyMesh(enemy: EnemyState): Group {
    const group = new THREE.Group();
    const geometry =
      enemy.kind === 'runner'
        ? this.runnerGeometry
        : enemy.kind === 'gunner'
          ? this.gunnerGeometry
          : this.bruteGeometry;
    const material =
      enemy.kind === 'runner'
        ? this.runnerMaterial
        : enemy.kind === 'gunner'
          ? this.gunnerMaterial
          : this.bruteMaterial;
    const body = new THREE.Mesh(geometry, material);
    body.position.y = enemy.kind === 'brute' ? 0.72 : 0.48;
    body.castShadow = true;
    group.add(body);

    const ring = new THREE.Mesh(
      this.enemyRingGeometry,
      enemy.kind === 'gunner' ? this.gunnerMaterial : this.runnerMaterial,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.08;
    ring.scale.setScalar(enemy.radius / 0.52);
    group.add(ring);

    if (enemy.kind === 'gunner') {
      const barrel = new THREE.Mesh(this.gunnerBarrelGeometry, this.bruteMaterial);
      barrel.position.set(0, 0.54, -0.42);
      group.add(barrel);
    }
    return group;
  }

  private createPickupMesh(pickup: PickupState): Group {
    const group = new THREE.Group();
    const material =
      pickup.kind === 'repair' ? this.repairMaterial : this.overdriveMaterial;
    const core = new THREE.Mesh(this.pickupGeometry, material);
    core.position.y = 0.52;
    group.add(core);
    const ring = new THREE.Mesh(this.pickupRingGeometry, material);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.18;
    group.add(ring);
    return group;
  }

  private syncScene(state: ArenaState): void {
    this.playerMesh.position.set(state.player.position.x, 0, state.player.position.y);
    this.playerMesh.rotation.y = Math.atan2(-state.player.aim.x, -state.player.aim.y);
    this.playerCore.scale.y = state.player.dashTime > 0 ? 0.68 : 1;
    this.playerMaterial.emissiveIntensity =
      state.player.overdriveTime > 0
        ? 1.35
        : state.player.invulnerableTime > 0
          ? 0.9
          : 0.5;

    const liveEnemies = new Set<number>();
    for (const enemy of state.enemies) {
      liveEnemies.add(enemy.id);
      let mesh = this.enemyMeshes.get(enemy.id);
      if (!mesh) {
        mesh = this.createEnemyMesh(enemy);
        this.enemyMeshes.set(enemy.id, mesh);
        this.addToScene(mesh);
      }
      mesh.position.set(enemy.position.x, 0, enemy.position.y);
      if (enemy.velocity.x !== 0 || enemy.velocity.y !== 0) {
        mesh.rotation.y = Math.atan2(-enemy.velocity.x, -enemy.velocity.y);
      }
      const healthScale = Math.max(0.55, enemy.health / enemy.maxHealth);
      mesh.scale.setScalar(0.92 + healthScale * 0.08);
      mesh.rotation.z = Math.sin(enemy.phase * 4 + enemy.id) * 0.025;
    }
    this.removeMissing(this.enemyMeshes, liveEnemies);

    const liveProjectiles = new Set<number>();
    for (const projectile of state.projectiles) {
      liveProjectiles.add(projectile.id);
      let mesh = this.projectileMeshes.get(projectile.id);
      if (!mesh) {
        mesh = this.createProjectileMesh(projectile);
        this.projectileMeshes.set(projectile.id, mesh);
        this.addToScene(mesh);
      }
      mesh.position.set(projectile.position.x, 0.46, projectile.position.y);
      mesh.scale.set(1, 1, 1.8);
      mesh.rotation.y = Math.atan2(-projectile.velocity.x, -projectile.velocity.y);
    }
    this.removeMissing(this.projectileMeshes, liveProjectiles);

    const livePickups = new Set<number>();
    for (const pickup of state.pickups) {
      livePickups.add(pickup.id);
      let mesh = this.pickupMeshes.get(pickup.id);
      if (!mesh) {
        mesh = this.createPickupMesh(pickup);
        this.pickupMeshes.set(pickup.id, mesh);
        this.addToScene(mesh);
      }
      mesh.position.set(pickup.position.x, 0, pickup.position.y);
      mesh.rotation.y += this.reducedMotion ? 0 : 0.025;
    }
    this.removeMissing(this.pickupMeshes, livePickups);
  }

  private createProjectileMesh(projectile: ProjectileState): Mesh {
    const mesh = new THREE.Mesh(
      this.projectileGeometry,
      projectile.owner === 'player'
        ? this.playerProjectileMaterial
        : this.hostileProjectileMaterial,
    );
    return mesh;
  }

  private removeMissing<T extends Object3D>(
    meshes: Map<number, T>,
    liveIds: Set<number>,
  ): void {
    for (const [id, mesh] of meshes) {
      if (liveIds.has(id)) continue;
      mesh.removeFromParent();
      meshes.delete(id);
    }
  }

  private processEvents(events: readonly ArenaEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'enemy-destroyed':
          this.spawnBurst(event.position, this.coralParticleMaterial, event.enemyId, 9);
          this.cameraShake = Math.max(this.cameraShake, 0.13);
          break;
        case 'hit':
          this.spawnBurst(
            event.position,
            event.target === 'player'
              ? this.coralParticleMaterial
              : this.limeParticleMaterial,
            event.target === 'player' ? 31 : 17,
            event.target === 'player' ? 7 : 3,
          );
          if (event.target === 'player') this.cameraShake = 0.42;
          break;
        case 'pickup':
          this.spawnBurst(event.position, this.blueParticleMaterial, 53, 7);
          break;
        case 'dash':
          this.spawnBurst(event.position, this.blueParticleMaterial, 71, 5);
          break;
        case 'shot':
          if (event.owner === 'player') {
            this.spawnBurst(event.position, this.limeParticleMaterial, 97, 1);
          }
          break;
        case 'game-over':
          this.cameraShake = event.status === 'defeated' ? 0.65 : 0.12;
          break;
      }
    }
  }

  private processAuthoritativeOnlineEvents(
    events: readonly SnapshotEvent[],
    localPlayerId: string,
  ): void {
    for (const event of events) {
      const seed = hashString(
        'playerId' in event
          ? event.playerId
          : 'ownerId' in event
            ? event.ownerId
            : event.victimId,
      );
      switch (event.type) {
        case 'dash':
          this.spawnBurst(
            { x: event.x, y: event.y },
            this.blueParticleMaterial,
            seed ^ event.tick,
            4,
          );
          break;
        case 'shot':
          this.spawnBurst(
            { x: event.x, y: event.y },
            event.ownerId === localPlayerId
              ? this.limeParticleMaterial
              : this.coralParticleMaterial,
            seed ^ event.projectileId,
            1,
          );
          break;
        case 'hit':
          this.spawnBurst(
            { x: event.x, y: event.y },
            event.targetId === localPlayerId
              ? this.coralParticleMaterial
              : this.limeParticleMaterial,
            seed ^ event.projectileId,
            event.targetId === localPlayerId ? 7 : 3,
          );
          if (event.targetId === localPlayerId) this.cameraShake = 0.34;
          break;
        case 'player-eliminated':
          this.spawnBurst(
            { x: event.x, y: event.y },
            this.coralParticleMaterial,
            seed ^ event.tick,
            10,
          );
          if (event.victimId === localPlayerId) this.cameraShake = 0.55;
          break;
        case 'player-respawned':
          this.spawnBurst(
            { x: event.x, y: event.y },
            this.blueParticleMaterial,
            seed ^ event.tick,
            7,
          );
          break;
        case 'player-joined':
          this.spawnBurst(
            { x: event.x, y: event.y },
            this.limeParticleMaterial,
            seed ^ event.tick,
            4,
          );
          break;
        case 'player-left': {
          const visual = this.onlinePlayerMeshes.get(event.playerId);
          if (visual) {
            this.spawnBurst(
              { x: visual.group.position.x, y: visual.group.position.z },
              this.blueParticleMaterial,
              seed ^ event.tick,
              3,
            );
            visual.group.removeFromParent();
            visual.label.remove();
            this.onlinePlayerMeshes.delete(event.playerId);
          }
          this.onlineMarkerByPlayerId.delete(event.playerId);
          break;
        }
      }
    }
  }

  private spawnBurst(
    position: Vector2,
    material: Material,
    seed: number,
    requestedCount: number,
  ): void {
    const count = this.reducedMotion ? Math.min(2, requestedCount) : requestedCount;
    for (let index = 0; index < count; index += 1) {
      const particleLimit = this.reducedMotion
        ? MAX_REDUCED_MOTION_PARTICLES
        : MAX_PARTICLES;
      if (this.particles.length >= particleLimit) break;
      const angle = seededUnit(seed, index) * Math.PI * 2;
      const speed = 1.2 + seededUnit(seed + 19, index) * 3.4;
      const mesh = new THREE.Mesh(this.particleGeometry, material);
      mesh.position.set(position.x, 0.42, position.y);
      const maxLife = 0.25 + seededUnit(seed + 43, index) * 0.34;
      this.particles.push({
        life: maxLife,
        maxLife,
        mesh,
        spin: {
          x: seededUnit(seed + 61, index) * 4 - 2,
          y: seededUnit(seed + 79, index) * 4 - 2,
        },
        velocity: new THREE.Vector3(
          Math.cos(angle) * speed,
          1.3 + seededUnit(seed + 23, index) * 2.2,
          Math.sin(angle) * speed,
        ),
      });
      this.addToScene(mesh);
    }
  }

  private updateParticles(delta: number): void {
    for (let index = this.particles.length - 1; index >= 0; index -= 1) {
      const particle = this.particles[index];
      if (!particle) continue;
      particle.life -= delta;
      if (particle.life <= 0) {
        particle.mesh.removeFromParent();
        this.particles.splice(index, 1);
        continue;
      }
      particle.velocity.y -= 7.5 * delta;
      particle.mesh.position.addScaledVector(particle.velocity, delta);
      particle.mesh.rotation.x += particle.spin.x * delta;
      particle.mesh.rotation.y += particle.spin.y * delta;
      particle.mesh.scale.setScalar(Math.max(0.08, particle.life / particle.maxLife));
    }
  }

  private updateCamera(delta: number, elapsed: number): void {
    const portrait = this.viewportAspect < 0.85;
    const compact = this.viewportAspect < 1.2;
    const baseHeight = portrait ? 35 : compact ? 31 : 27;
    const baseDepth = portrait ? 24 : compact ? 21 : 18;
    const player = this.localPlayerPosition;
    const followX = player ? player.x * 0.08 : 0;
    const followZ = player ? player.y * 0.05 : 0;
    const shake = this.reducedMotion ? 0 : this.cameraShake;
    const shakeX = Math.sin(elapsed * 83) * shake;
    const shakeZ = Math.cos(elapsed * 67) * shake;
    const targetPosition = new THREE.Vector3(
      followX + shakeX,
      baseHeight,
      baseDepth + followZ + shakeZ,
    );
    const blend = this.reducedMotion ? 1 : Math.min(1, delta * 3.8);
    this.camera.position.lerp(targetPosition, blend);
    this.camera.lookAt(followX, 0, followZ - 1.2);
    this.cameraShake = Math.max(0, this.cameraShake - delta * 1.8);
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.contextLost || this.disposed) return;
    this.contextLost = true;
    this.options.onContextLost();
  };

  private clearLocalDynamicScene(): void {
    for (const mesh of this.enemyMeshes.values()) mesh.removeFromParent();
    for (const mesh of this.projectileMeshes.values()) mesh.removeFromParent();
    for (const mesh of this.pickupMeshes.values()) mesh.removeFromParent();
    this.enemyMeshes.clear();
    this.projectileMeshes.clear();
    this.pickupMeshes.clear();
    this.clearParticles();
  }

  private clearOnlineScene(retainMarkers = false): void {
    for (const visual of this.onlinePlayerMeshes.values()) {
      visual.group.removeFromParent();
      visual.label.remove();
    }
    for (const mesh of this.onlineProjectileMeshes.values()) mesh.removeFromParent();
    this.onlinePlayerMeshes.clear();
    this.onlineProjectileMeshes.clear();
    if (!retainMarkers) this.onlineMarkerByPlayerId.clear();
    this.clearParticles();
  }

  private clearParticles(): void {
    for (const particle of this.particles) particle.mesh.removeFromParent();
    this.particles.length = 0;
  }

  private updateOnlineLabels(): void {
    if (this.presentationMode !== 'online') return;
    const width = Math.max(1, this.options.host.clientWidth);
    const height = Math.max(1, this.options.host.clientHeight);
    this.camera.updateMatrixWorld();
    for (const visual of this.onlinePlayerMeshes.values()) {
      this.labelProjection
        .set(visual.group.position.x, 1.25, visual.group.position.z)
        .project(this.camera);
      const visible = this.labelProjection.z >= -1 && this.labelProjection.z <= 1;
      visual.label.hidden = !visible;
      if (!visible) continue;
      const x = (this.labelProjection.x * 0.5 + 0.5) * width;
      const y = (-this.labelProjection.y * 0.5 + 0.5) * height;
      visual.label.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
    }
  }

  private readonly resize = (): void => {
    const renderer = this.renderer;
    if (this.disposed || !renderer) return;
    const width = Math.max(1, this.options.host.clientWidth);
    const height = Math.max(1, this.options.host.clientHeight);
    this.viewportAspect = width / height;
    this.camera.aspect = this.viewportAspect;
    this.camera.fov =
      this.viewportAspect < 0.85 ? 54 : this.viewportAspect < 1.2 ? 50 : 44;
    this.camera.updateProjectionMatrix();
    renderer.setPixelRatio(this.pixelRatio());
    renderer.setSize(width, height, false);
  };

  private pixelRatio(): number {
    const cap = this.reducedMotion ? 1 : 1.5;
    return Math.min(globalThis.devicePixelRatio || 1, cap);
  }

  private addBox(
    width: number,
    height: number,
    depth: number,
    material: Material,
    x: number,
    y: number,
    z: number,
    castShadow = false,
  ): Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    this.addToScene(mesh);
    return mesh;
  }

  private addToScene(object: Object3D): void {
    this.trackObjectResources(object);
    this.scene.add(object);
  }

  private trackGeometry<T extends BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  private trackMaterial<T extends Material>(material: T): T {
    this.materials.add(material);
    return material;
  }

  private trackObjectResources(object: Object3D): void {
    object.traverse((entry) => {
      const renderable = entry as Mesh | Line | Points;
      if (renderable.geometry instanceof THREE.BufferGeometry) {
        this.geometries.add(renderable.geometry);
      }
      const material = renderable.material;
      if (Array.isArray(material)) {
        for (const item of material) this.materials.add(item);
      } else if (material instanceof THREE.Material) {
        this.materials.add(material);
      }
    });
  }
}

function normalizeVector(vector: Vector2, fallback: Vector2): Vector2 {
  const magnitude = Math.hypot(vector.x, vector.y);
  return magnitude > 0.0001
    ? { x: vector.x / magnitude, y: vector.y / magnitude }
    : fallback;
}

function seededUnit(seed: number, index: number): number {
  let value = Math.imul(seed ^ Math.imul(index + 1, 0x45d9f3b), 0x27d4eb2d);
  value ^= value >>> 15;
  return (value >>> 0) / 4_294_967_296;
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
