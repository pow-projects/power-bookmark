import { describe, it, expect, beforeEach } from 'vitest';
import { isBlockedUrl, sanitizeDOM, shouldSkipIframe } from '../../src/lib/archive/archive-sanitizer';

describe('archive-sanitizer', () => {
  describe('isBlockedUrl', () => {
    it('정확한 도메인 매치에 대해 true를 반환한다 (예: https://doubleclick.net/ad)', () => {
      expect(isBlockedUrl('https://doubleclick.net/ad')).toBe(true);
    });

    it('하위 도메인 매치에 대해 true를 반환한다 (예: https://gum.criteo.com/syncframe)', () => {
      expect(isBlockedUrl('https://gum.criteo.com/syncframe')).toBe(true);
    });

    it('차단되지 않은 도메인에 대해 false를 반환한다 (예: https://example.com)', () => {
      expect(isBlockedUrl('https://example.com')).toBe(false);
    });

    it('콘텐츠 임베드 도메인에 대해 false를 반환한다 (YouTube, Vimeo)', () => {
      expect(isBlockedUrl('https://www.youtube.com/embed/12345')).toBe(false);
      expect(isBlockedUrl('https://player.vimeo.com/video/12345')).toBe(false);
    });

    it('유효하지 않거나 빈 URL에 대해 false를 반환한다', () => {
      expect(isBlockedUrl('')).toBe(false);
      expect(isBlockedUrl('invalid-url')).toBe(false);
    });

    it('data: URL에 대해 false를 반환한다', () => {
      expect(isBlockedUrl('data:text/plain;base64,SGVsbG8sIFdvcmxkIQ==')).toBe(false);
    });
  });

  describe('sanitizeDOM', () => {
    let parser: DOMParser;

    beforeEach(() => {
      parser = new DOMParser();
    });

    it('광고 iframe을 제거한다 (criteo, doubleclick 등)', () => {
      const doc = parser.parseFromString(`
        <div>
          <iframe src="https://gum.criteo.com/syncframe"></iframe>
          <iframe src="https://doubleclick.net/ad"></iframe>
        </div>
      `, 'text/html');
      sanitizeDOM(doc);
      expect(doc.querySelectorAll('iframe').length).toBe(0);
    });

    it('크기가 0인 iframe을 제거한다', () => {
      const doc = parser.parseFromString(`
        <div>
          <iframe src="https://example.com" width="0" height="0"></iframe>
        </div>
      `, 'text/html');
      sanitizeDOM(doc);
      expect(doc.querySelectorAll('iframe').length).toBe(0);
    });

    it('추적 픽셀 (1x1 이미지)을 제거한다', () => {
      const doc = parser.parseFromString(`
        <div>
          <img src="https://tracker.com/pixel.gif" width="1" height="1" />
        </div>
      `, 'text/html');
      sanitizeDOM(doc);
      expect(doc.querySelectorAll('img').length).toBe(0);
    });

    it('광고 컨테이너를 제거한다 (.adsbygoogle, [data-ad-slot] 등)', () => {
      const doc = parser.parseFromString(`
        <div>
          <div class="adsbygoogle">광고</div>
          <div data-ad-slot="12345">광고</div>
        </div>
      `, 'text/html');
      sanitizeDOM(doc);
      expect(doc.querySelector('.adsbygoogle')).toBeNull();
      expect(doc.querySelector('[data-ad-slot]')).toBeNull();
    });

    it('쿠키 동의 배너를 제거한다', () => {
      const doc = parser.parseFromString(`
        <div>
          <div id="cookie-consent">동의하시겠습니까?</div>
          <div class="cookie-banner">동의</div>
        </div>
      `, 'text/html');
      sanitizeDOM(doc);
      expect(doc.querySelector('#cookie-consent')).toBeNull();
      expect(doc.querySelector('.cookie-banner')).toBeNull();
    });

    it('소셜 위젯 iframe을 제거한다', () => {
      const doc = parser.parseFromString(`
        <div>
          <iframe src="https://www.facebook.com/plugins/like.php"></iframe>
        </div>
      `, 'text/html');
      sanitizeDOM(doc);
      expect(doc.querySelectorAll('iframe').length).toBe(0);
    });

    it('prefetch/preconnect link 태그를 제거한다', () => {
      const doc = parser.parseFromString(`
        <head>
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="prefetch" href="https://example.com/script.js">
          <link rel="stylesheet" href="style.css">
        </head>
      `, 'text/html');
      sanitizeDOM(doc);
      expect(doc.querySelector('link[rel="preconnect"]')).toBeNull();
      expect(doc.querySelector('link[rel="prefetch"]')).toBeNull();
      expect(doc.querySelector('link[rel="stylesheet"]')).not.toBeNull();
    });

    it('CRITICAL: <article> 내의 요소는 제거하지 않는다', () => {
      const doc = parser.parseFromString(`
        <article>
          <iframe src="https://doubleclick.net/ad"></iframe>
          <div class="adsbygoogle">광고</div>
          <img src="tracker.gif" width="1" height="1" />
        </article>
      `, 'text/html');
      sanitizeDOM(doc);
      expect(doc.querySelectorAll('iframe').length).toBe(1);
      expect(doc.querySelectorAll('.adsbygoogle').length).toBe(1);
      expect(doc.querySelectorAll('img').length).toBe(1);
    });

    it('CRITICAL: <main> 내의 요소는 제거하지 않는다', () => {
      const doc = parser.parseFromString(`
        <main>
          <iframe src="https://doubleclick.net/ad"></iframe>
          <div class="adsbygoogle">광고</div>
        </main>
      `, 'text/html');
      sanitizeDOM(doc);
      expect(doc.querySelectorAll('iframe').length).toBe(1);
      expect(doc.querySelectorAll('.adsbygoogle').length).toBe(1);
    });

    it('CRITICAL: [role="main"] 내의 요소는 제거하지 않는다', () => {
      const doc = parser.parseFromString(`
        <div role="main">
          <iframe src="https://doubleclick.net/ad"></iframe>
          <div class="adsbygoogle">광고</div>
        </div>
      `, 'text/html');
      sanitizeDOM(doc);
      expect(doc.querySelectorAll('iframe').length).toBe(1);
      expect(doc.querySelectorAll('.adsbygoogle').length).toBe(1);
    });

    it('정상적인 iframe을 유지한다 (예: YouTube 임베드)', () => {
      const doc = parser.parseFromString(`
        <div>
          <iframe src="https://www.youtube.com/embed/12345" width="560" height="315"></iframe>
        </div>
      `, 'text/html');
      sanitizeDOM(doc);
      expect(doc.querySelectorAll('iframe').length).toBe(1);
    });

    it('정상적인 이미지를 유지한다', () => {
      const doc = parser.parseFromString(`
        <div>
          <img src="image.jpg" width="800" height="600" />
        </div>
      `, 'text/html');
      sanitizeDOM(doc);
      expect(doc.querySelectorAll('img').length).toBe(1);
    });

    it('빈 문서에서 에러를 던지지 않는다', () => {
      const doc = parser.parseFromString('', 'text/html');
      expect(() => sanitizeDOM(doc)).not.toThrow();
    });
  });

  describe('shouldSkipIframe', () => {
    it('알려진 트래커 iframe URL에 대해 true를 반환한다', () => {
      expect(shouldSkipIframe('https://doubleclick.net/ad')).toBe(true);
    });

    it('콘텐츠 iframe URL에 대해 false를 반환한다 (YouTube, Vimeo 등)', () => {
      expect(shouldSkipIframe('https://www.youtube.com/embed/12345')).toBe(false);
      expect(shouldSkipIframe('https://player.vimeo.com/video/12345')).toBe(false);
    });

    it('빈/null/undefined 입력에 대해 false를 반환한다', () => {
      expect(shouldSkipIframe('')).toBe(false);
      expect(shouldSkipIframe(null as any)).toBe(false);
      expect(shouldSkipIframe(undefined as any)).toBe(false);
    });

    it('상대 URL에 대해 false를 반환한다', () => {
      expect(shouldSkipIframe('/relative/path')).toBe(false);
    });
  });
});
