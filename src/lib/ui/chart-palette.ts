/**
 * Chart Theme & Palette Colors
 * Aligns with assets/styles/components.css (--chart-1..10) and assets/styles/design-system.css
 */

export interface ChartThemeColors {
  textColor: string;
  gridColor: string;
}

/**
 * 10-Color Palette aligned with components.css --chart-1..10
 */
export const CHART_PALETTE: readonly string[] = [
  '#D6453D', // Ribbon Red (--chart-1)
  '#0F766E', // Stamp Teal (--chart-2)
  '#B45309', // Amber (--chart-3)
  '#4338CA', // Indigo (--chart-4)
  '#0284C7', // Sky (--chart-5)
  '#D97706', // Warm Gold (--chart-6)
  '#6D28D9', // Purple (--chart-7)
  '#059669', // Emerald (--chart-8)
  '#BE185D', // Rose (--chart-9)
  '#475569', // Slate (--chart-10)
] as const;

/**
 * Health & Visit Status Colors aligned with design system
 * (Unvisited / 1-visit / 2-5 visits / 6+ visits)
 */
export const CHART_HEALTH_COLORS: readonly string[] = [
  '#98A0AC', // Unvisited (--text-muted)
  '#5A6472', // Single visit (--text-secondary)
  '#0F766E', // Revisit 2-5 (--color-success / teal)
  '#D6453D', // Frequent 6+ (--color-primary / red)
] as const;

/**
 * Dynamic text & grid colors based on theme (light / dark)
 */
export function getChartThemeColors(isDark: boolean): ChartThemeColors {
  return {
    textColor: isDark ? '#cbd5e1' : '#475569',
    gridColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)'
  };
}
