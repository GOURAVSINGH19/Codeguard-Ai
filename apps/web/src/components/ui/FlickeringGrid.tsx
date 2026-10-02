"use client";

import React, { useEffect, useRef } from "react";

/**
 * Canvas grid of tiny squares whose opacity flickers at random — the textured
 * backdrop CodeRabbit uses behind its empty states. Purely decorative.
 */
export default function FlickeringGrid({
  squareSize = 3,
  gap = 3,
  color = "255, 255, 255",
  maxOpacity = 0.09,
  flickerChance = 0.25,
  className = "",
}: {
  squareSize?: number;
  gap?: number;
  /** "r, g, b" */
  color?: string;
  maxOpacity?: number;
  /** Fraction of squares that change per second. */
  flickerChance?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const step = squareSize + gap;
    let cols = 0;
    let rows = 0;
    let opacities = new Float32Array(0);
    let timer: ReturnType<typeof setInterval> | undefined;
    let last = performance.now();
    // ~12fps is plenty for a flicker and far cheaper than redrawing every frame.
    const FRAME_MS = 80;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(width / step);
      rows = Math.ceil(height / step);
      opacities = new Float32Array(cols * rows).map(() => Math.random() * maxOpacity);
      draw();
    };

    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          ctx.fillStyle = `rgba(${color}, ${opacities[i * rows + j]})`;
          ctx.fillRect(i * step, j * step, squareSize, squareSize);
        }
      }
    };

    const tick = () => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const changes = opacities.length * flickerChance * dt;
      for (let n = 0; n < changes; n++) {
        opacities[(Math.random() * opacities.length) | 0] = Math.random() * maxOpacity;
      }
      draw();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // Only animate while on screen, and never for reduced-motion users.
    let visible = false;
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      clearInterval(timer);
      if (visible && !reduceMotion) {
        last = performance.now();
        timer = setInterval(tick, FRAME_MS);
      }
    });
    io.observe(canvas);

    return () => {
      clearInterval(timer);
      ro.disconnect();
      io.disconnect();
    };
  }, [squareSize, gap, color, maxOpacity, flickerChance]);

  return <canvas ref={canvasRef} aria-hidden className={`pointer-events-none absolute inset-0 h-full w-full ${className}`} />;
}
