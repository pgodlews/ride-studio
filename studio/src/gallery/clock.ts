/**
 * Preview clock. Ride time is the single source of truth (video follows it), and it is
 * quantised to output frames so the preview shows exactly what an export would draw.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export const FPS = 30;

export interface Clock {
  t: number;
  playing: boolean;
  loop: [number, number] | null;
  setT: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setLoop: (range: [number, number] | null) => void;
}

export function useClock(initial: number, duration: number): Clock {
  const [t, setTState] = useState(initial);
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState<[number, number] | null>(null);
  const exact = useRef(initial);
  const loopRef = useRef(loop);
  loopRef.current = loop;

  const setT = useCallback((v: number) => {
    exact.current = Math.min(duration, Math.max(0, v));
    setTState(Math.round(exact.current * FPS) / FPS);
  }, [duration]);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      let next = exact.current + Math.min(0.1, (now - last) / 1000);
      last = now;
      const range = loopRef.current;
      if (range && (next > range[1] || next < range[0])) next = range[0];
      if (next >= duration) next = 0;
      exact.current = next;
      const frame = Math.round(next * FPS) / FPS;
      setTState((prev) => (prev === frame ? prev : frame));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);

  return { t, playing, loop, setT, setPlaying, setLoop };
}
