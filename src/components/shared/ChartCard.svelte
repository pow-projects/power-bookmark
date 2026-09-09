<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Chart, registerables, type ChartConfiguration } from 'chart.js';
  import { getChartThemeColors } from '../../lib/ui/chart-palette';

  Chart.register(...registerables);

  export let title = '';
  export let type: 'bar' | 'line' | 'doughnut' = 'bar';
  export let labels: string[] = [];
  export let datasets: any[] = [];
  export let showLegend = false;
  export let options: any = {};

  let canvasEl: HTMLCanvasElement;
  let chartInstance: Chart | null = null;

  // Handle dark mode detection
  let observer: MutationObserver;

  onMount(() => {
    renderChart();

    // Watch <html> attribute to update font/grid colors on theme toggle
    observer = new MutationObserver(() => {
      if (chartInstance) {
        chartInstance.destroy();
        renderChart();
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
  });

  onDestroy(() => {
    if (chartInstance) {
      chartInstance.destroy();
    }
    if (observer) {
      observer.disconnect();
    }
  });

  // Update chart on data change
  $: {
    if (chartInstance && (labels || datasets)) {
      chartInstance.data.labels = labels;
      chartInstance.data.datasets = datasets;
      chartInstance.update();
    }
  }

  function renderChart() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const { textColor, gridColor } = getChartThemeColors(isDark);

    const defaultOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: showLegend,
          labels: {
            color: textColor,
            font: {
              family: "'IBM Plex Mono', monospace",
              size: 11
            }
          }
        }
      },
      scales: type !== 'doughnut' ? {
        x: {
          grid: {
            color: gridColor
          },
          ticks: {
            color: textColor,
            font: {
              family: "'IBM Plex Mono', monospace"
            }
          }
        },
        y: {
          grid: {
            color: gridColor
          },
          ticks: {
            color: textColor,
            font: {
              family: "'IBM Plex Mono', monospace"
            }
          }
        }
      } : undefined
    };

    const config: ChartConfiguration = {
      type: type,
      data: {
        labels: labels,
        datasets: datasets
      },
      options: {
        ...defaultOptions,
        ...options,
        plugins: {
          ...defaultOptions.plugins,
          ...(options.plugins || {})
        }
      }
    };

    chartInstance = new Chart(canvasEl, config);
  }
</script>

<div class="chart-card">
  {#if title}
    <h4>{title}</h4>
  {/if}
  <div class="chart-container">
    <canvas bind:this={canvasEl}></canvas>
  </div>
</div>

<style>
  .chart-card {
    background-color: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-lg);
    padding: 1.25rem;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 320px;
    height: 100%;
    transition: transform var(--transition-fast), border-color var(--transition-fast);
  }

  .chart-card:hover {
    transform: translateY(-2px);
    border-color: var(--border-focus);
  }

  h4 {
    margin: 0;
    font-size: 0.95rem;
    font-family: var(--font-accent);
    color: var(--text-primary);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .chart-container {
    position: relative;
    flex-grow: 1;
    width: 100%;
    height: 100%;
  }
</style>
