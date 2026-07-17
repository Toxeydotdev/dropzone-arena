import type { Vector2 } from '@dropzone-arena/arena-engine';

export interface ArenaControlState {
  aim: Vector2;
  dash: boolean;
  firing: boolean;
  move: Vector2;
}

export type ArenaInputInterruption = 'blur' | 'hidden';

export interface ArenaInputControllerOptions {
  element: HTMLElement;
  getAimOrigin(): Vector2 | null;
  onInterruption(reason: ArenaInputInterruption): void;
  onMenuRequested(): void;
  projectPointerAim(
    clientX: number,
    clientY: number,
    origin: Vector2,
    fallback: Vector2,
  ): Vector2;
}

export class ArenaInputController {
  private readonly pressedKeys = new Set<string>();
  private disposed = false;
  private enabled = false;
  private pointerFiring = false;
  private touchFiring = false;
  private dashQueued = false;
  private pointerAim: Vector2 = { x: 0, y: -1 };
  private touchAim: Vector2 = { x: 0, y: -1 };
  private touchMove: Vector2 = { x: 0, y: 0 };

  constructor(private readonly options: ArenaInputControllerOptions) {
    globalThis.addEventListener('keydown', this.handleKeyDown);
    globalThis.addEventListener('keyup', this.handleKeyUp);
    globalThis.addEventListener('blur', this.handleBlur);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    options.element.addEventListener('pointermove', this.handlePointerMove);
    options.element.addEventListener('pointerdown', this.handlePointerDown);
    options.element.addEventListener('pointerup', this.handlePointerUp);
    options.element.addEventListener('pointercancel', this.handlePointerUp);
    options.element.addEventListener('lostpointercapture', this.handlePointerUp);
  }

  clear(): void {
    this.pressedKeys.clear();
    this.pointerFiring = false;
    this.touchFiring = false;
    this.touchMove = { x: 0, y: 0 };
    this.dashQueued = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.clear();
    globalThis.removeEventListener('keydown', this.handleKeyDown);
    globalThis.removeEventListener('keyup', this.handleKeyUp);
    globalThis.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.options.element.removeEventListener('pointermove', this.handlePointerMove);
    this.options.element.removeEventListener('pointerdown', this.handlePointerDown);
    this.options.element.removeEventListener('pointerup', this.handlePointerUp);
    this.options.element.removeEventListener('pointercancel', this.handlePointerUp);
    this.options.element.removeEventListener(
      'lostpointercapture',
      this.handlePointerUp,
    );
  }

  read(): ArenaControlState {
    const keyboardMove = {
      x:
        Number(this.pressedKeys.has('KeyD') || this.pressedKeys.has('ArrowRight')) -
        Number(this.pressedKeys.has('KeyA') || this.pressedKeys.has('ArrowLeft')),
      y:
        Number(this.pressedKeys.has('KeyS') || this.pressedKeys.has('ArrowDown')) -
        Number(this.pressedKeys.has('KeyW') || this.pressedKeys.has('ArrowUp')),
    };
    const move = clampVector({
      x: keyboardMove.x + this.touchMove.x,
      y: keyboardMove.y + this.touchMove.y,
    });
    const touchAimActive =
      this.touchFiring && vectorLengthSquared(this.touchAim) > 0.04;
    const dash = this.dashQueued;
    this.dashQueued = false;

    return {
      aim: touchAimActive ? this.touchAim : this.pointerAim,
      dash,
      firing: this.pointerFiring || this.touchFiring,
      move,
    };
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  setTouchAim(direction: Vector2, firing: boolean): void {
    if (!this.enabled || this.disposed) return;
    this.touchAim = direction;
    this.touchFiring = firing;
  }

  setTouchMove(direction: Vector2): void {
    if (!this.enabled || this.disposed) return;
    this.touchMove = direction;
  }

  triggerDash(): void {
    if (this.enabled && !this.disposed) this.dashQueued = true;
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    if (event.code === 'Escape' || event.code === 'KeyP') {
      event.preventDefault();
      this.options.onMenuRequested();
      return;
    }
    if (!isGameplayKey(event.code)) return;
    event.preventDefault();
    this.pressedKeys.add(event.code);
    if (
      (event.code === 'Space' ||
        event.code === 'ShiftLeft' ||
        event.code === 'ShiftRight') &&
      !event.repeat
    ) {
      this.dashQueued = true;
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.pressedKeys.delete(event.code);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    this.updatePointerAim(event);
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.enabled || event.button !== 0 || event.pointerType === 'touch') return;
    event.preventDefault();
    this.updatePointerAim(event);
    this.pointerFiring = true;
    this.options.element.setPointerCapture(event.pointerId);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    this.pointerFiring = false;
  };

  private readonly handleBlur = (): void => {
    if (this.enabled) this.options.onInterruption('blur');
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden' && this.enabled) {
      this.options.onInterruption('hidden');
    }
  };

  private updatePointerAim(event: PointerEvent): void {
    const origin = this.options.getAimOrigin();
    if (!origin) return;
    this.pointerAim = this.options.projectPointerAim(
      event.clientX,
      event.clientY,
      origin,
      this.pointerAim,
    );
  }
}

function isGameplayKey(code: string): boolean {
  return [
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'KeyA',
    'KeyD',
    'KeyS',
    'KeyW',
    'ShiftLeft',
    'ShiftRight',
    'Space',
  ].includes(code);
}

function clampVector(vector: Vector2): Vector2 {
  const magnitude = Math.hypot(vector.x, vector.y);
  return magnitude > 1 ? { x: vector.x / magnitude, y: vector.y / magnitude } : vector;
}

function vectorLengthSquared(vector: Vector2): number {
  return vector.x * vector.x + vector.y * vector.y;
}
