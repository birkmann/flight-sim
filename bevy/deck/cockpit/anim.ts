/**
 * Needle smoothing: snapshots arrive at ~15 Hz, instruments move at display rate. One shared rAF loop
 * eases every registered value towards its target (exponential, time constant `tau`) and writes the
 * result straight to the DOM — no React re-render per frame.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Tween = {
  value: number;
  target: number;
  tau: number;
  applied: number;
  continuous: boolean;
  apply: (v: number, time: number) => void;
};

const tweens = new Set<Tween>();
let raf = 0;
let lastT = 0;

function frame(now: number) {
  const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 60;
  lastT = now;
  const time = now / 1000;
  for (const tw of tweens) {
    const k = tw.tau <= 0 ? 1 : 1 - Math.exp(-dt / tw.tau);
    tw.value += (tw.target - tw.value) * k;
    if (tw.continuous || Math.abs(tw.value - tw.applied) > 0.004) {
      tw.applied = tw.value;
      tw.apply(tw.value, time);
    }
  }
  raf = tweens.size ? requestAnimationFrame(frame) : 0;
  if (!raf) lastT = 0;
}

/**
 * Ease `target` and hand the eased value to `apply` every frame it changes.
 * `wrap` (e.g. 360) makes angles take the short way round (the eased value is unwrapped).
 * `continuous` calls `apply` every frame (for flutter driven by time).
 */
export function useTween(
  target: number,
  apply: (v: number, time: number) => void,
  opts: { tau?: number; wrap?: number; continuous?: boolean } = {},
) {
  const ref = useRef<Tween | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const safe = Number.isFinite(target) ? target : 0;
  if (!ref.current) {
    ref.current = {
      value: safe,
      target: safe,
      tau: opts.tau ?? 0.12,
      applied: NaN,
      continuous: !!opts.continuous,
      apply: (v, t) => applyRef.current(v, t),
    };
  }
  const tw = ref.current;
  tw.tau = opts.tau ?? 0.12;
  if (opts.wrap) {
    const w = opts.wrap;
    const cur = ((tw.target % w) + w) % w;
    let d = (((safe - cur) % w) + w) % w;
    if (d > w / 2) d -= w;
    tw.target += d;
  } else tw.target = safe;

  useLayoutEffect(() => {
    tw.applied = tw.value;
    tw.apply(tw.value, performance.now() / 1000);
    tweens.add(tw);
    if (!raf) raf = requestAnimationFrame(frame);
    return () => {
      tweens.delete(tw);
    };
  }, [tw]);
}

/** Window size, re-rendering on resize. */
export function useViewport() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}
