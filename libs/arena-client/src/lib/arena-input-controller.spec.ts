import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Vector2 } from '@dropzone-arena/arena-engine';

import { ArenaInputController } from './arena-input-controller';

const controllers: ArenaInputController[] = [];

afterEach(() => {
  for (const controller of controllers) controller.dispose();
  controllers.length = 0;
  vi.restoreAllMocks();
});

describe('ArenaInputController', () => {
  it('normalizes keyboard movement and consumes each dash edge once', () => {
    const { controller } = createController();
    controller.setEnabled(true);

    dispatchKey('keydown', 'KeyW');
    dispatchKey('keydown', 'KeyD');
    const dashEvent = dispatchKey('keydown', 'Space');

    const first = controller.read();
    expect(dashEvent.defaultPrevented).toBe(true);
    expect(first.move.x).toBeCloseTo(Math.SQRT1_2);
    expect(first.move.y).toBeCloseTo(-Math.SQRT1_2);
    expect(first.dash).toBe(true);
    expect(controller.read().dash).toBe(false);

    dispatchKey('keydown', 'Space', true);
    expect(controller.read().dash).toBe(false);
    controller.triggerDash();
    expect(controller.read().dash).toBe(true);
    expect(controller.read().dash).toBe(false);
  });

  it('projects pointer aim and clears held keyboard, pointer, touch, and dash state', () => {
    const projectedAim = { x: 1, y: 0 };
    const { controller, element, projectPointerAim } = createController(projectedAim);
    controller.setEnabled(true);

    dispatchKey('keydown', 'KeyA');
    dispatchPointer(element, 'pointerdown', {
      clientX: 42,
      clientY: 24,
      pointerId: 7,
    });
    controller.setTouchMove({ x: 0, y: 1 });
    controller.setTouchAim({ x: 0, y: 1 }, true);
    controller.triggerDash();

    expect(projectPointerAim).toHaveBeenCalledWith(
      42,
      24,
      { x: 3, y: 4 },
      { x: 0, y: -1 },
    );
    expect(controller.read()).toMatchObject({
      aim: { x: 0, y: 1 },
      dash: true,
      firing: true,
    });

    controller.triggerDash();
    controller.clear();
    expect(controller.read()).toEqual({
      aim: projectedAim,
      dash: false,
      firing: false,
      move: { x: 0, y: 0 },
    });
  });

  it('reports menu and interruption requests without choosing driver policy', () => {
    const { controller, onInterruption, onMenuRequested } = createController();
    controller.setEnabled(true);
    dispatchKey('keydown', 'KeyW');

    const menuEvent = dispatchKey('keydown', 'Escape');
    globalThis.dispatchEvent(new Event('blur'));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(menuEvent.defaultPrevented).toBe(true);
    expect(onMenuRequested).toHaveBeenCalledOnce();
    expect(onInterruption.mock.calls).toEqual([['blur'], ['hidden']]);
    expect(controller.read().move).toEqual({ x: 0, y: -1 });
  });

  it('removes listeners and stays neutral after idempotent disposal', () => {
    const { controller, element, onInterruption, onMenuRequested } = createController();
    controller.setEnabled(true);
    dispatchKey('keydown', 'KeyW');
    controller.triggerDash();

    controller.dispose();
    controller.dispose();
    dispatchKey('keydown', 'Escape');
    dispatchKey('keydown', 'KeyD');
    dispatchPointer(element, 'pointerdown', { pointerId: 2 });
    globalThis.dispatchEvent(new Event('blur'));

    expect(onMenuRequested).not.toHaveBeenCalled();
    expect(onInterruption).not.toHaveBeenCalled();
    expect(controller.read()).toEqual({
      aim: { x: 0, y: -1 },
      dash: false,
      firing: false,
      move: { x: 0, y: 0 },
    });
  });
});

function createController(projectedAim = { x: 1, y: 0 }) {
  const element = document.createElement('canvas');
  Object.defineProperty(element, 'setPointerCapture', {
    configurable: true,
    value: vi.fn<(pointerId: number) => void>(),
  });
  const onInterruption = vi.fn<(reason: 'blur' | 'hidden') => void>();
  const onMenuRequested = vi.fn<() => void>();
  const projectPointerAim = vi.fn<
    (clientX: number, clientY: number, origin: Vector2, fallback: Vector2) => Vector2
  >(() => projectedAim);
  const controller = new ArenaInputController({
    element,
    getAimOrigin: () => ({ x: 3, y: 4 }),
    onInterruption,
    onMenuRequested,
    projectPointerAim,
  });
  controllers.push(controller);
  return {
    controller,
    element,
    onInterruption,
    onMenuRequested,
    projectPointerAim,
  };
}

function dispatchKey(type: 'keydown' | 'keyup', code: string, repeat = false) {
  const event = new KeyboardEvent(type, {
    cancelable: true,
    code,
    repeat,
  });
  globalThis.dispatchEvent(event);
  return event;
}

function dispatchPointer(
  element: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  options: {
    clientX?: number;
    clientY?: number;
    pointerId?: number;
  } = {},
) {
  const event = new MouseEvent(type, {
    button: 0,
    cancelable: true,
    clientX: options.clientX,
    clientY: options.clientY,
  });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 1 },
    pointerType: { value: 'mouse' },
  });
  element.dispatchEvent(event);
  return event;
}
