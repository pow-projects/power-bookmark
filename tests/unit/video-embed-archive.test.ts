import { describe, it, expect, beforeEach } from 'vitest';
import {
  getYouTubeVideoId,
  getYouTubeVideoInfo,
  getTikTokVideoId,
  isVideoEmbedUrl,
  createYouTubeEmbedElement,
  createTikTokEmbedElement,
  preserveOrInjectVideoEmbeds,
  parseYouTubeTimestamp
} from '../../src/lib/archive/video-embed-helper';
import { capturePageHtml } from '../../src/lib/archive/page-capture';

describe('video-embed-helper', () => {
  describe('getYouTubeVideoId & parseYouTubeTimestamp', () => {
    it('extracts ID from standard watch URL', () => {
      expect(getYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(getYouTubeVideoId('https://youtube.com/watch?v=dQw4w9WgXcQ&feature=share')).toBe('dQw4w9WgXcQ');
    });

    it('extracts ID and timestamp from watch URL with &t= and &list=', () => {
      const info = getYouTubeVideoInfo('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=1m30s');
      expect(info?.videoId).toBe('dQw4w9WgXcQ');
      expect(info?.startSeconds).toBe(90);
    });

    it('extracts ID from mobile watch URL', () => {
      expect(getYouTubeVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('extracts ID from youtu.be short URL with timestamp', () => {
      expect(getYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      const info = getYouTubeVideoInfo('https://youtu.be/dQw4w9WgXcQ?t=120');
      expect(info?.videoId).toBe('dQw4w9WgXcQ');
      expect(info?.startSeconds).toBe(120);
    });

    it('extracts ID from shorts and live URLs', () => {
      expect(getYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(getYouTubeVideoId('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('extracts ID from embed URL', () => {
      expect(getYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
      expect(getYouTubeVideoId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    });

    it('returns null for non-YouTube or invalid URLs or malformed IDs', () => {
      expect(getYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
      expect(getYouTubeVideoId('https://youtube.com/feed/subscriptions')).toBeNull();
      expect(getYouTubeVideoId('https://youtube.com/watch?v=tooshort')).toBeNull();
      expect(getYouTubeVideoId('https://attacker-youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
      expect(getYouTubeVideoId('')).toBeNull();
    });

    it('parses timestamps correctly', () => {
      expect(parseYouTubeTimestamp('120s')).toBe(120);
      expect(parseYouTubeTimestamp('1h2m3s')).toBe(3723);
      expect(parseYouTubeTimestamp('0')).toBeUndefined();
      expect(parseYouTubeTimestamp(null)).toBeUndefined();
    });
  });

  describe('getTikTokVideoId', () => {
    it('extracts ID from standard TikTok video URL', () => {
      expect(
        getTikTokVideoId('https://www.tiktok.com/@scout2015/video/7123456789012345678')
      ).toBe('7123456789012345678');
      expect(
        getTikTokVideoId('https://www.tiktok.com/@user/video/7123456789012345678?is_from_webapp=1')
      ).toBe('7123456789012345678');
    });

    it('extracts ID from TikTok photo post carousel URL', () => {
      expect(
        getTikTokVideoId('https://www.tiktok.com/@user/photo/7123456789012345678')
      ).toBe('7123456789012345678');
    });

    it('extracts ID from mobile or short /v/ URL', () => {
      expect(getTikTokVideoId('https://m.tiktok.com/v/7123456789012345678')).toBe('7123456789012345678');
      expect(getTikTokVideoId('https://www.tiktok.com/v/7123456789012345678')).toBe('7123456789012345678');
    });

    it('extracts ID from embed URL', () => {
      expect(getTikTokVideoId('https://www.tiktok.com/embed/v2/7123456789012345678')).toBe('7123456789012345678');
    });

    it('returns null for non-TikTok or user-only URLs or spoofed domains', () => {
      expect(getTikTokVideoId('https://www.tiktok.com/@username')).toBeNull();
      expect(getTikTokVideoId('https://evil-tiktok.com/@user/video/7123456789')).toBeNull();
      expect(getTikTokVideoId('https://example.com/@user/video/7123456789')).toBeNull();
      expect(getTikTokVideoId('')).toBeNull();
    });
  });

  describe('isVideoEmbedUrl', () => {
    it('identifies YouTube embed URLs including protocol-relative URLs', () => {
      expect(isVideoEmbedUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(true);
      expect(isVideoEmbedUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe(true);
      expect(isVideoEmbedUrl('//www.youtube.com/embed/dQw4w9WgXcQ')).toBe(true);
    });

    it('identifies TikTok embed URLs', () => {
      expect(isVideoEmbedUrl('https://www.tiktok.com/embed/v2/7123456789012345678')).toBe(true);
    });

    it('identifies Vimeo and Dailymotion embed URLs', () => {
      expect(isVideoEmbedUrl('https://player.vimeo.com/video/12345678')).toBe(true);
      expect(isVideoEmbedUrl('https://www.dailymotion.com/embed/video/x7tgad0')).toBe(true);
    });

    it('identifies Korean video platform embed URLs (KakaoTV, Daum, Naver)', () => {
      expect(isVideoEmbedUrl('https://tv.kakao.com/embed/player/cliplink/400000000')).toBe(true);
      expect(isVideoEmbedUrl('https://play-tv.kakao.com/embed/player/cliplink/400000000')).toBe(true);
      expect(isVideoEmbedUrl('https://videofarm.daum.net/controller/video/viewer/Video.html?vid=123')).toBe(true);
      expect(isVideoEmbedUrl('https://tv.naver.com/embed/123456')).toBe(true);
      expect(isVideoEmbedUrl('https://serviceapi.rmcnmv.naver.com/flash/outKeyPlayer.nhn?vid=123')).toBe(true);
    });

    it('returns false for regular web URLs and spoofed domains', () => {
      expect(isVideoEmbedUrl('https://example.com/iframe.html')).toBe(false);
      expect(isVideoEmbedUrl('https://evil-vimeo.com/video/123')).toBe(false);
      expect(isVideoEmbedUrl('https://news.ycombinator.com')).toBe(false);
    });
  });

  describe('preserveOrInjectVideoEmbeds', () => {
    let parser: DOMParser;

    beforeEach(() => {
      parser = new DOMParser();
    });

    it('injects responsive YouTube player into YouTube watch page DOM with timestamp', () => {
      const doc = parser.parseFromString(
        `<!DOCTYPE html><html><head></head><body><div id="player"></div><div id="content">Title</div></body></html>`,
        'text/html'
      );
      preserveOrInjectVideoEmbeds(doc, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45s', 'Sample Video');

      const iframe = doc.querySelector('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe?.getAttribute('src')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=0&rel=0&start=45');
      expect(iframe?.getAttribute('allowfullscreen')).toBe('true');
      expect(iframe?.getAttribute('allow')).toContain('autoplay');
      expect(iframe?.getAttribute('allow')).toContain('fullscreen');
      expect(iframe?.getAttribute('allow')).toContain('encrypted-media');
      expect(iframe?.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    });

    it('is strictly idempotent when called multiple times on the same document', () => {
      const doc = parser.parseFromString(
        `<!DOCTYPE html><html><head></head><body><h1>Bare Video</h1></body></html>`,
        'text/html'
      );
      preserveOrInjectVideoEmbeds(doc, 'https://youtu.be/dQw4w9WgXcQ', 'Shorts Video');
      preserveOrInjectVideoEmbeds(doc, 'https://youtu.be/dQw4w9WgXcQ', 'Shorts Video');

      const iframes = doc.querySelectorAll('.power-bookmark-youtube-embed');
      expect(iframes.length).toBe(1);
    });

    it('resolves TikTok short links via canonical link tag in DOM', () => {
      const doc = parser.parseFromString(
        `<!DOCTYPE html><html><head><link rel="canonical" href="https://www.tiktok.com/@user/video/7123456789012345678" /></head><body></body></html>`,
        'text/html'
      );
      preserveOrInjectVideoEmbeds(doc, 'https://vt.tiktok.com/ZS12345/', 'Short TikTok Link');

      const iframe = doc.querySelector('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe?.getAttribute('src')).toBe('https://www.tiktok.com/embed/v2/7123456789012345678');
    });

    it('converts TikTok blockquote embeds with cite fallback into live iframes', () => {
      const doc = parser.parseFromString(
        `<!DOCTYPE html><html><head></head><body>
          <blockquote class="tiktok-embed" cite="https://www.tiktok.com/@scout2015/video/7123456789012345678">
            <section>Fallback text</section>
          </blockquote>
        </body></html>`,
        'text/html'
      );
      preserveOrInjectVideoEmbeds(doc, 'https://blog.example.com/post-1');

      expect(doc.querySelector('blockquote.tiktok-embed')).toBeNull();
      const iframe = doc.querySelector('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe?.getAttribute('src')).toBe('https://www.tiktok.com/embed/v2/7123456789012345678');
    });

    it('preserves existing video embed iframes and attaches loading=lazy and permissions', () => {
      const doc = parser.parseFromString(
        `<!DOCTYPE html><html><head></head><body>
          <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
        </body></html>`,
        'text/html'
      );
      preserveOrInjectVideoEmbeds(doc, 'https://blog.example.com/my-post');

      const iframe = doc.querySelector('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe?.getAttribute('src')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
      expect(iframe?.getAttribute('allow')).toContain('fullscreen');
      expect(iframe?.getAttribute('allowfullscreen')).toBe('true');
      expect(iframe?.getAttribute('loading')).toBe('lazy');
    });
  });

  describe('capturePageHtml with video embeds', () => {
    it('does NOT replace video embed iframes with srcdoc even if iframeSources contains it', async () => {
      const html = `<!DOCTYPE html>
        <html>
          <head><title>Blog with Video</title></head>
          <body>
            <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
          </body>
        </html>`;

      const iframeSources = {
        'https://www.youtube.com/embed/dQw4w9WgXcQ': '<html><body>Fake YouTube Raw HTML</body></html>'
      };

      const blob = await capturePageHtml(
        html,
        'https://example.com/article',
        'Blog with Video',
        '',
        iframeSources,
        false
      );

      const capturedHtml = await blob.text();
      expect(capturedHtml).not.toContain('srcdoc=');
      expect(capturedHtml).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
      expect(capturedHtml).toContain('allowfullscreen="true"');
      expect(capturedHtml).toContain('accelerometer;');
    });

    it('faithfully injects playable embed when capturing a YouTube video page', async () => {
      const youtubeHtml = `<!DOCTYPE html>
        <html>
          <head><title>Never Gonna Give You Up - YouTube</title></head>
          <body>
            <div id="player"><video src="blob:https://www.youtube.com/123"></video></div>
            <div id="content"><h1>Song Title</h1></div>
          </body>
        </html>`;

      const blob = await capturePageHtml(
        youtubeHtml,
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'Never Gonna Give You Up',
        '',
        {},
        false
      );

      const capturedHtml = await blob.text();
      expect(capturedHtml).toContain('https://www.youtube.com/embed/dQw4w9WgXcQ');
      expect(capturedHtml).toContain('allowfullscreen="true"');
    });
  });
});
