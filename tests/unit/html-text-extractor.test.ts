import { describe, it, expect } from 'vitest';
import {
  decodeHtmlEntities,
  extractMetaFromHtml,
  extractTextFromHtml,
  extractPagePayloadFromHtml
} from '../../src/lib/archive/html-text-extractor';

describe('html-text-extractor (Service Worker 호환 HTML 텍스트/메타 추출기)', () => {
  describe('decodeHtmlEntities', () => {
    it('명명된 표준 HTML 엔티티를 올바르게 디코딩한다', () => {
      const input = 'Tom &amp; Jerry &quot;Show&quot; &lt;Cartoons&gt; &copy; 2026 &nbsp; &#39;Special&#39; &apos;Edition&apos;';
      const output = decodeHtmlEntities(input);
      expect(output).toBe('Tom & Jerry "Show" <Cartoons> © 2026   \'Special\' \'Edition\'');
    });

    it('10진수 수치 엔티티를 디코딩한다', () => {
      const input = '&#65;&#66;&#67; &#40;&#41; &#8212; &#44032;';
      const output = decodeHtmlEntities(input);
      expect(output).toBe('ABC () — 가');
    });

    it('16진수 수치 엔티티를 디코딩한다', () => {
      const input = '&#x41;&#x42;&#x43; &#x2F; &#x27; &#xAC00;';
      const output = decodeHtmlEntities(input);
      expect(output).toBe("ABC / ' 가");
    });

    it('알 수 없는 엔티티나 빈 문자열은 안전하게 처리한다', () => {
      expect(decodeHtmlEntities('')).toBe('');
      expect(decodeHtmlEntities('&unknownentity;')).toBe('&unknownentity;');
    });
  });

  describe('extractMetaFromHtml', () => {
    it('표준 <title> 및 <meta name="description"> 추출', () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>My Awesome Page &amp; Guide</title>
            <meta name="description" content="This is an awesome guide for &quot;developers&quot;.">
          </head>
          <body><h1>Content</h1></body>
        </html>
      `;
      const meta = extractMetaFromHtml(html);
      expect(meta.title).toBe('My Awesome Page & Guide');
      expect(meta.metaDescription).toBe('This is an awesome guide for "developers".');
    });

    it('<title>이 없을 때 og:title 또는 twitter:title로 폴백', () => {
      const html = `
        <html>
          <head>
            <meta property="og:title" content="OpenGraph Title">
            <meta property="og:description" content="OpenGraph Description">
          </head>
        </html>
      `;
      const meta = extractMetaFromHtml(html);
      expect(meta.title).toBe('OpenGraph Title');
      expect(meta.metaDescription).toBe('OpenGraph Description');
    });

    it('content 속성이 name/property보다 앞에 위치한 meta 태그도 정상 처리', () => {
      const html = `
        <html>
          <head>
            <meta content="Twitter Title" name="twitter:title">
            <meta content="Twitter Description" name="twitter:description">
          </head>
        </html>
      `;
      const meta = extractMetaFromHtml(html);
      expect(meta.title).toBe('Twitter Title');
      expect(meta.metaDescription).toBe('Twitter Description');
    });
  });

  describe('extractTextFromHtml', () => {
    it('script, style, noscript, header, footer, nav, aside, form, svg 태그와 그 내용을 제거한다', () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Ignored in text</title>
            <style>body { color: red; } .ad { display: block; }</style>
            <script>console.log("secret script code");</script>
          </head>
          <body>
            <header>
              <nav>
                <a href="/home">Home</a>
                <a href="/about">About</a>
              </nav>
            </header>
            <main>
              <h1>Main Headline</h1>
              <p>This is the first paragraph with <strong>important</strong> content.</p>
              <form action="/search">
                <input type="text" name="q">
                <button type="submit">Search</button>
              </form>
              <svg><path d="M0 0h24v24H0z"/></svg>
              <p>Second paragraph with &amp; entities &quot;quotes&quot;.</p>
              <aside>Sidebar information to ignore</aside>
              <noscript><p>Please enable JS</p></noscript>
              <iframe src="https://ads.example.com"></iframe>
            </main>
            <footer>
              <p>&copy; 2026 Company Footer</p>
            </footer>
          </body>
        </html>
      `;

      const text = extractTextFromHtml(html);
      expect(text).not.toContain('console.log');
      expect(text).not.toContain('color: red');
      expect(text).not.toContain('Home');
      expect(text).not.toContain('About');
      expect(text).not.toContain('Search');
      expect(text).not.toContain('Sidebar information');
      expect(text).not.toContain('Please enable JS');
      expect(text).not.toContain('Company Footer');
      expect(text).toContain('Main Headline');
      expect(text).toContain('This is the first paragraph with important content.');
      expect(text).toContain('Second paragraph with & entities "quotes".');
    });

    it('HTML 주석 및 줄바꿈을 공백으로 정상 정규화한다', () => {
      const html = `
        <div>
          <!-- Comment to remove -->
          <p>Hello</p>
          <p>World</p>
        </div>
      `;
      const text = extractTextFromHtml(html);
      expect(text).toBe('Hello World');
    });

    it('maxLength 길이에 맞춰 텍스트를 자른다', () => {
      const html = `<p>${'a'.repeat(200)}</p>`;
      const text = extractTextFromHtml(html, 50);
      expect(text.length).toBe(50);
    });
  });

  describe('extractPagePayloadFromHtml', () => {
    it('전체 HTML에서 ExtractedPagePayload를 일관되게 생성한다', () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>TypeScript Handbook</title>
            <meta name="description" content="Official TypeScript documentation and handbook">
          </head>
          <body>
            <h1>Getting Started</h1>
            <p>TypeScript is a strongly typed programming language that builds on JavaScript.</p>
          </body>
        </html>
      `;

      const payload = extractPagePayloadFromHtml(html, 'https://www.typescriptlang.org/docs/', 'Fallback');
      expect(payload.title).toBe('TypeScript Handbook');
      expect(payload.url).toBe('https://www.typescriptlang.org/docs/');
      expect(payload.metaDescription).toBe('Official TypeScript documentation and handbook');
      expect(payload.textContent).toContain('Getting Started');
      expect(payload.textContent).toContain('TypeScript is a strongly typed programming language');
      expect(payload.content).toBe(payload.textContent);
    });

    it('제목과 메타 설명이 없는 HTML의 경우 fallbackTitle을 사용한다', () => {
      const html = `<body><p>Simple body content without title tag.</p></body>`;
      const payload = extractPagePayloadFromHtml(html, 'https://example.com', 'My Fallback Title');
      expect(payload.title).toBe('My Fallback Title');
      expect(payload.url).toBe('https://example.com');
      expect(payload.metaDescription).toBe('');
      expect(payload.textContent).toBe('Simple body content without title tag.');
    });
  });
});
