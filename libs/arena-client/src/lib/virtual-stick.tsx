import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

import type { Vector2 } from '@dropzone-arena/arena-engine';

interface VirtualStickProps {
  disabled?: boolean;
  label: string;
  onChange(direction: Vector2, active: boolean): void;
  resetKey?: number;
}

export function VirtualStick({
  disabled = false,
  label,
  onChange,
  resetKey = 0,
}: VirtualStickProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const activePointerRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    activePointerRef.current = null;
    buttonRef.current?.style.setProperty('--stick-x', '0px');
    buttonRef.current?.style.setProperty('--stick-y', '0px');
    onChangeRef.current({ x: 0, y: 0 }, false);
  }, [disabled, resetKey]);

  useEffect(
    () => () => {
      onChangeRef.current({ x: 0, y: 0 }, false);
    },
    [],
  );

  const update = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const button = buttonRef.current;
    if (!button || activePointerRef.current !== event.pointerId) return;
    const bounds = button.getBoundingClientRect();
    const radius = Math.max(1, Math.min(bounds.width, bounds.height) * 0.32);
    const offsetX = event.clientX - (bounds.left + bounds.width / 2);
    const offsetY = event.clientY - (bounds.top + bounds.height / 2);
    const magnitude = Math.hypot(offsetX, offsetY);
    const scale = magnitude > radius ? radius / magnitude : 1;
    const x = (offsetX * scale) / radius;
    const y = (offsetY * scale) / radius;
    button.style.setProperty('--stick-x', `${x * radius}px`);
    button.style.setProperty('--stick-y', `${y * radius}px`);
    onChangeRef.current({ x, y }, true);
  };

  const reset = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    activePointerRef.current = null;
    buttonRef.current?.style.setProperty('--stick-x', '0px');
    buttonRef.current?.style.setProperty('--stick-y', '0px');
    onChangeRef.current({ x: 0, y: 0 }, false);
  };

  return (
    <button
      ref={buttonRef}
      className="virtual-stick"
      type="button"
      aria-label={label}
      disabled={disabled}
      onContextMenu={(event) => event.preventDefault()}
      onPointerCancel={reset}
      onPointerDown={(event) => {
        activePointerRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        update(event);
      }}
      onPointerMove={update}
      onPointerUp={reset}
    >
      <span className="virtual-stick__ring" aria-hidden="true" />
      <span className="virtual-stick__knob" aria-hidden="true" />
      <span className="virtual-stick__label" aria-hidden="true">
        {label.replace(' stick', '')}
      </span>
    </button>
  );
}
