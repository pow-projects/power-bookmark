import { describe, it, expect } from 'vitest';
import {
  CHART_PALETTE,
  CHART_HEALTH_COLORS,
  getChartThemeColors
} from '../../src/lib/ui/chart-palette';

describe('Chart Palette & Theme Tokens', () => {
  it('exports a 10-color palette matching components.css --chart-1..10', () => {
    expect(CHART_PALETTE).toHaveLength(10);
    expect(CHART_PALETTE[0]).toBe('#D6453D');
    expect(CHART_PALETTE[1]).toBe('#0F766E');
    expect(CHART_PALETTE[2]).toBe('#B45309');
    expect(CHART_PALETTE[3]).toBe('#4338CA');
    expect(CHART_PALETTE[4]).toBe('#0284C7');
    expect(CHART_PALETTE[5]).toBe('#D97706');
    expect(CHART_PALETTE[6]).toBe('#6D28D9');
    expect(CHART_PALETTE[7]).toBe('#059669');
    expect(CHART_PALETTE[8]).toBe('#BE185D');
    expect(CHART_PALETTE[9]).toBe('#475569');
  });

  it('exports 4 health/revisit status colors', () => {
    expect(CHART_HEALTH_COLORS).toHaveLength(4);
    expect(CHART_HEALTH_COLORS[0]).toBe('#98A0AC');
    expect(CHART_HEALTH_COLORS[1]).toBe('#5A6472');
    expect(CHART_HEALTH_COLORS[2]).toBe('#0F766E');
    expect(CHART_HEALTH_COLORS[3]).toBe('#D6453D');
  });

  it('returns appropriate text and grid colors for light and dark themes', () => {
    const lightTheme = getChartThemeColors(false);
    expect(lightTheme.textColor).toBe('#475569');
    expect(lightTheme.gridColor).toBe('rgba(0, 0, 0, 0.05)');

    const darkTheme = getChartThemeColors(true);
    expect(darkTheme.textColor).toBe('#cbd5e1');
    expect(darkTheme.gridColor).toBe('rgba(255, 255, 255, 0.08)');
  });
});
