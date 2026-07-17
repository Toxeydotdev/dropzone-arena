import { useSyncExternalStore } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function reducedMotionSnapshot(): boolean {
  return typeof globalThis.matchMedia === 'function'
    ? globalThis.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof globalThis.matchMedia !== 'function') return () => undefined;
  const query = globalThis.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => false,
  );
}
