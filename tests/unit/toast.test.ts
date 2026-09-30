import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { tick } from 'svelte';
import {
  toasts,
  showToast,
  dismissToast,
  clearToasts,
  pauseToast,
  resumeToast,
  calculateToastDuration,
  MAX_ACTIVE_TOASTS,
  DEFAULT_TOAST_DURATIONS,
} from '../../src/lib/ui/toast-store';
import ToastComponent from '../../src/components/shared/Toast.svelte';

// Polyfill Element.prototype.animate for jsdom Svelte transitions
if (typeof Element !== 'undefined') {
  Element.prototype.animate = vi.fn().mockImplementation(() => ({
    finished: Promise.resolve(),
    cancel: vi.fn(),
    onfinish: null,
    play: vi.fn(),
    pause: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('Toast System', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    clearToasts();
    vi.useRealTimers();
  });

  describe('toast-store unit tests', () => {
    it('shows toast with different types and returns an id string', () => {
      const types = ['success', 'error', 'info', 'warning'] as const;

      types.forEach(type => {
        clearToasts();
        const id = showToast(`Message for ${type}`, type);
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);

        const currentToasts = get(toasts);
        expect(currentToasts).toHaveLength(1);
        expect(currentToasts[0].id).toBe(id);
        expect(currentToasts[0].type).toBe(type);
        expect(currentToasts[0].message).toBe(`Message for ${type}`);
        expect(currentToasts[0].count).toBe(1);
      });
    });

    it('defaults to info type when type is not provided', () => {
      const id = showToast('Default info message');
      const current = get(toasts);
      expect(current).toHaveLength(1);
      expect(current[0].id).toBe(id);
      expect(current[0].type).toBe('info');
    });

    it('auto-dismisses toast after duration expires', () => {
      showToast('Dismiss me soon', 'success', 2000);
      expect(get(toasts)).toHaveLength(1);

      vi.advanceTimersByTime(1999);
      expect(get(toasts)).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(get(toasts)).toHaveLength(0);
    });

    it('deduplicates identical active messages and increments count counter', () => {
      const id1 = showToast('Duplicate test', 'info', 3000);
      expect(get(toasts)).toHaveLength(1);
      expect(get(toasts)[0].count).toBe(1);

      const id2 = showToast('Duplicate test', 'info', 3000);
      expect(id2).toBe(id1);
      expect(get(toasts)).toHaveLength(1);
      expect(get(toasts)[0].count).toBe(2);

      const id3 = showToast('Duplicate test', 'info', 3000);
      expect(id3).toBe(id1);
      expect(get(toasts)).toHaveLength(1);
      expect(get(toasts)[0].count).toBe(3);

      // Verify timer is refreshed on duplicate
      vi.advanceTimersByTime(2000);
      expect(get(toasts)).toHaveLength(1);

      // Advance by another 1500ms (total 3500ms since id1, but only 1500ms since id3)
      vi.advanceTimersByTime(1500);
      expect(get(toasts)).toHaveLength(0);
    });

    it('implements FIFO eviction when exceeding MAX_ACTIVE_TOASTS (4)', () => {
      expect(MAX_ACTIVE_TOASTS).toBe(4);

      const id1 = showToast('Toast 1', 'info', 10000);
      const id2 = showToast('Toast 2', 'info', 10000);
      const id3 = showToast('Toast 3', 'info', 10000);
      const id4 = showToast('Toast 4', 'info', 10000);

      expect(get(toasts)).toHaveLength(4);
      expect(get(toasts).map(t => t.id)).toEqual([id1, id2, id3, id4]);

      // Adding 5th toast evicts the oldest (id1)
      const id5 = showToast('Toast 5', 'info', 10000);
      expect(get(toasts)).toHaveLength(4);
      expect(get(toasts).map(t => t.id)).toEqual([id2, id3, id4, id5]);

      // Adding 6th toast evicts id2
      const id6 = showToast('Toast 6', 'info', 10000);
      expect(get(toasts)).toHaveLength(4);
      expect(get(toasts).map(t => t.id)).toEqual([id3, id4, id5, id6]);
    });

    it('dismissToast clears the timer and removes the toast', () => {
      const id1 = showToast('Toast to dismiss', 'info', 5000);
      const id2 = showToast('Keep this toast', 'info', 5000);

      expect(get(toasts)).toHaveLength(2);

      dismissToast(id1);
      expect(get(toasts)).toHaveLength(1);
      expect(get(toasts)[0].id).toBe(id2);

      // Fast-forward time past 5000ms
      vi.advanceTimersByTime(5001);
      expect(get(toasts)).toHaveLength(0);
    });

    it('clearToasts clears all toasts and their active timers', () => {
      showToast('T1', 'info', 5000);
      showToast('T2', 'error', 5000);
      showToast('T3', 'success', 5000);

      expect(get(toasts)).toHaveLength(3);

      clearToasts();
      expect(get(toasts)).toHaveLength(0);

      // Advance timers to ensure no resurrecting side-effects
      vi.advanceTimersByTime(10000);
      expect(get(toasts)).toHaveLength(0);
    });

    it('calculates adaptive duration based on text length and type defaults', () => {
      // Short messages (<= 20 chars) should match base defaults
      expect(calculateToastDuration('Short text', 'success')).toBe(DEFAULT_TOAST_DURATIONS.success);
      expect(calculateToastDuration('Short text', 'info')).toBe(DEFAULT_TOAST_DURATIONS.info);
      expect(calculateToastDuration('Short text', 'warning')).toBe(DEFAULT_TOAST_DURATIONS.warning);
      expect(calculateToastDuration('Short text', 'error')).toBe(DEFAULT_TOAST_DURATIONS.error);

      // Longer message adds ~50ms per character beyond 20 chars
      const text40Chars = 'a'.repeat(40);
      const expectedInfo40 = DEFAULT_TOAST_DURATIONS.info + (40 - 20) * 50;
      expect(calculateToastDuration(text40Chars, 'info')).toBe(expectedInfo40);

      // Capped at 10,000ms
      const veryLongText = 'a'.repeat(500);
      expect(calculateToastDuration(veryLongText, 'error')).toBe(10000);

      // Explicit durationMs in showToast overrides adaptive calculation
      showToast('Short', 'info', 1234);
      expect(get(toasts)[0].duration).toBe(1234);
    });

    it('pauses and resumes auto-dismiss timer', () => {
      const id = showToast('Hover me', 'info', 3000);

      // 1000ms elapses
      vi.advanceTimersByTime(1000);
      expect(get(toasts)).toHaveLength(1);

      // Pause
      pauseToast(id);

      // Advance by 5000ms while paused
      vi.advanceTimersByTime(5000);
      expect(get(toasts)).toHaveLength(1);

      // Resume
      resumeToast(id);

      // Should still be active immediately after resume
      expect(get(toasts)).toHaveLength(1);

      // Remaining duration is 2000ms (3000 - 1000)
      vi.advanceTimersByTime(1999);
      expect(get(toasts)).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(get(toasts)).toHaveLength(0);
    });
  });

  describe('Toast.svelte Component Integration', () => {
    it('renders container with accessibility attributes', async () => {
      const target = document.createElement('div');
      document.body.appendChild(target);

      new ToastComponent({ target });
      await tick();

      const container = document.querySelector('.toast-container');
      expect(container).not.toBeNull();
      expect(container?.getAttribute('aria-live')).toBe('polite');
      expect(container?.getAttribute('aria-atomic')).toBe('true');
    });

    it('renders toast item with role="alert" for error and warning, role="status" for others', async () => {
      const target = document.createElement('div');
      document.body.appendChild(target);

      new ToastComponent({ target });

      showToast('Error msg', 'error');
      showToast('Warning msg', 'warning');
      showToast('Success msg', 'success');
      showToast('Info msg', 'info');

      await tick();

      const items = document.querySelectorAll('.toast-item');
      expect(items.length).toBe(4);

      expect(items[0].getAttribute('role')).toBe('alert');
      expect(items[1].getAttribute('role')).toBe('alert');
      expect(items[2].getAttribute('role')).toBe('status');
      expect(items[3].getAttribute('role')).toBe('status');
    });

    it('renders count badge when toast has count > 1', async () => {
      const target = document.createElement('div');
      document.body.appendChild(target);

      new ToastComponent({ target });

      showToast('Count test', 'info');
      await tick();
      expect(document.querySelector('.count-badge')).toBeNull();

      showToast('Count test', 'info');
      await tick();

      const badge = document.querySelector('.count-badge');
      expect(badge).not.toBeNull();
      expect(badge?.textContent?.trim()).toBe('x2');
    });

    it('dismisses toast on manual dismiss button click', async () => {
      const target = document.createElement('div');
      document.body.appendChild(target);

      new ToastComponent({ target });

      const id = showToast('To be manually dismissed', 'info');
      await tick();

      const dismissBtn = document.querySelector('.dismiss-btn') as HTMLButtonElement;
      expect(dismissBtn).not.toBeNull();

      dismissBtn.click();
      await tick();

      expect(get(toasts)).toHaveLength(0);
    });

    it('renders copy button for long error messages (> 40 chars)', async () => {
      const target = document.createElement('div');
      document.body.appendChild(target);

      new ToastComponent({ target });

      const longError = 'Network request failed: Error communicating with remote sync server timeout after 30s';
      showToast(longError, 'error');
      await tick();

      const copyBtn = document.querySelector('.copy-btn') as HTMLButtonElement;
      expect(copyBtn).not.toBeNull();
      expect(copyBtn.getAttribute('aria-label')).toBe('Copy error message');
    });

    it('does not render copy button for short errors or non-error toasts', async () => {
      const target = document.createElement('div');
      document.body.appendChild(target);

      new ToastComponent({ target });

      showToast('Short error', 'error');
      showToast('A very long success message that exceeds 40 characters easily', 'success');
      await tick();

      const copyBtns = document.querySelectorAll('.copy-btn');
      expect(copyBtns.length).toBe(0);
    });

    it('applies warning styling class and warning icon for warning type', async () => {
      const target = document.createElement('div');
      document.body.appendChild(target);

      new ToastComponent({ target });

      showToast('Warning text', 'warning');
      await tick();

      const warningItem = document.querySelector('.toast-item.warning');
      expect(warningItem).not.toBeNull();

      const warningIcon = document.querySelector('.warning-icon');
      expect(warningIcon).not.toBeNull();
    });
  });
});
