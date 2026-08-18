import { useEffect, useState } from 'react';

/**
 * Chart colours have to reach Recharts as real hex, because an SVG `fill`
 * attribute does not resolve var(). The CSS tokens in styles.css and this
 * table are the same palette expressed twice; keep them in step.
 *
 * Both modes are chosen, not flipped: the dark column is the same three hues
 * re-stepped for the dark surface. Validated as a set (all-pairs) with the
 * dataviz validator — worst CVD deltaE 9.2 light / 9.4 dark, worst
 * normal-vision 24.0 / 20.9.
 */
export const PALETTE = {
  light: {
    /**
     * Multi-series marks use these three, which validate on ALL pairs.
     * `slots` is the full eight-hue order, which validates on ADJACENT pairs —
     * the right pairlist for pie segments and stacks, and capped at six
     * segments so it is never cycled.
     */
    slots: [
      '#2a78d6', '#eb6834', '#1baf7a', '#eda100',
      '#e87ba4', '#008300', '#4a3aa7', '#e34948',
    ],
    series: ['#2a78d6', '#eb6834', '#1baf7a'],
    surface: '#fcfcfb',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    muted: '#898781',
    text: '#0b0b0b',
    secondary: '#52514e',
  },
  dark: {
    slots: [
      '#3987e5', '#d95926', '#199e70', '#c98500',
      '#d55181', '#008300', '#9085e9', '#e66767',
    ],
    series: ['#3987e5', '#d95926', '#199e70'],
    surface: '#1a1a19',
    grid: '#2c2c2a',
    axis: '#383835',
    muted: '#898781',
    text: '#ffffff',
    secondary: '#c3c2b7',
  },
} as const;

export type Mode = 'light' | 'dark';

const STORAGE_KEY = 'rafai-ai-theme';

function systemMode(): Mode {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme() {
  const [mode, setMode] = useState<Mode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : systemMode();
  });

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  return {
    mode,
    palette: PALETTE[mode],
    toggle: () => setMode((m) => (m === 'dark' ? 'light' : 'dark')),
  };
}
