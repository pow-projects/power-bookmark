import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import OvercrowdedFolderBanner from '../../src/components/management/bookmarks/OvercrowdedFolderBanner.svelte';

describe('OvercrowdedFolderBanner.svelte', () => {
  let target: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.body;
  });

  it('renders banner when visible is true, count >= 50, and folder is provided', async () => {
    new OvercrowdedFolderBanner({
      target,
      props: {
        folder: 'Bookmarks bar/Tech',
        count: 52,
        visible: true
      }
    });
    await tick();

    const bannerEl = document.querySelector('.overcrowded-folder-banner');
    expect(bannerEl).not.toBeNull();
    expect(bannerEl?.getAttribute('role')).toBe('status');

    const messageEl = document.querySelector('.banner-message');
    expect(messageEl?.textContent).toContain('Bookmarks bar/Tech');
    expect(messageEl?.textContent).toContain('52');
  });

  it('does not render banner when count is below threshold (< 50)', async () => {
    new OvercrowdedFolderBanner({
      target,
      props: {
        folder: 'Bookmarks bar/Tech',
        count: 49,
        visible: true
      }
    });
    await tick();

    const bannerEl = document.querySelector('.overcrowded-folder-banner');
    expect(bannerEl).toBeNull();
  });

  it('does not render banner when visible is false', async () => {
    new OvercrowdedFolderBanner({
      target,
      props: {
        folder: 'Bookmarks bar/Tech',
        count: 60,
        visible: false
      }
    });
    await tick();

    const bannerEl = document.querySelector('.overcrowded-folder-banner');
    expect(bannerEl).toBeNull();
  });

  it('does not render banner when folder is empty', async () => {
    new OvercrowdedFolderBanner({
      target,
      props: {
        folder: '',
        count: 60,
        visible: true
      }
    });
    await tick();

    const bannerEl = document.querySelector('.overcrowded-folder-banner');
    expect(bannerEl).toBeNull();
  });

  it('dispatches "dismiss" event when dismiss button is clicked', async () => {
    const comp = new OvercrowdedFolderBanner({
      target,
      props: {
        folder: 'Bookmarks bar/Development',
        count: 55,
        visible: true
      }
    });
    await tick();

    const dismissSpy = vi.fn();
    comp.$on('dismiss', dismissSpy);

    const btn = document.querySelector('.btn-dismiss') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    await btn.click();
    await tick();

    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });

  it('uses SVG Icon components and contains no unicode emoji icons', async () => {
    new OvercrowdedFolderBanner({
      target,
      props: {
        folder: 'Bookmarks bar/Tech',
        count: 50,
        visible: true
      }
    });
    await tick();

    const svgs = document.querySelectorAll('.overcrowded-folder-banner svg');
    expect(svgs.length).toBeGreaterThanOrEqual(2); // alert-circle and x icons

    // Strictly verify no emoji icons in banner
    const bannerText = document.querySelector('.overcrowded-folder-banner')?.textContent || '';
    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
    expect(emojiRegex.test(bannerText)).toBe(false);
  });
});
