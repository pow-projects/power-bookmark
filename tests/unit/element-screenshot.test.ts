import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  captureVisibleTab,
  downloadBlob,
  captureElementScreenshot
} from '../../src/lib/ui/element-screenshot';

describe('element-screenshot 유틸리티 단위 테스트', () => {
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const origGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();

    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback, type?: string) {
      callback(new Blob(['mock-png'], { type: type || 'image/png' }));
    };

    HTMLCanvasElement.prototype.getContext = function (contextId: string) {
      if (contextId === '2d') {
        return {
          drawImage: vi.fn(),
          getImageData: vi.fn(),
          putImageData: vi.fn()
        } as any;
      }
      return null;
    };

    if (typeof URL.createObjectURL !== 'function') {
      URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    }
    if (typeof URL.revokeObjectURL !== 'function') {
      URL.revokeObjectURL = vi.fn();
    }
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.toBlob = origToBlob;
    HTMLCanvasElement.prototype.getContext = origGetContext;
    vi.unstubAllGlobals();
  });

  describe('captureVisibleTab', () => {
    it('browser.tabs.captureVisibleTab이 사용 가능할 때 직접 호출하여 dataUrl 반환', async () => {
      const mockCapture = vi.fn().mockResolvedValue('data:image/png;base64,sampleDirect');
      vi.stubGlobal('browser', {
        tabs: {
          captureVisibleTab: mockCapture
        }
      });

      const res = await captureVisibleTab();
      expect(res).toBe('data:image/png;base64,sampleDirect');
      expect(mockCapture).toHaveBeenCalledWith({ format: 'png' });
    });

    it('직접 호출 실패 시 browser.runtime.sendMessage 릴레이로 폴백', async () => {
      const mockDirect = vi.fn().mockRejectedValue(new Error('Direct tab capture forbidden'));
      const mockSendMessage = vi.fn().mockResolvedValue({
        ok: true,
        dataUrl: 'data:image/png;base64,sampleRelay'
      });

      vi.stubGlobal('browser', {
        tabs: {
          captureVisibleTab: mockDirect
        },
        runtime: {
          sendMessage: mockSendMessage
        }
      });

      const res = await captureVisibleTab();
      expect(res).toBe('data:image/png;base64,sampleRelay');
      expect(mockSendMessage).toHaveBeenCalledWith({ type: 'PB_CAPTURE_VISIBLE_TAB' });
    });

    it('사용 가능한 API가 없거나 모두 실패할 경우 에러 throw', async () => {
      vi.stubGlobal('browser', undefined);

      await expect(captureVisibleTab()).rejects.toThrow(
        'No captureVisibleTab API available in current environment'
      );
    });
  });

  describe('downloadBlob', () => {
    it('browser.downloads.download API가 있을 때 이를 호출하여 다운로드 수행', async () => {
      const mockDownload = vi.fn().mockResolvedValue(42);
      vi.stubGlobal('browser', {
        downloads: {
          download: mockDownload
        }
      });

      const testBlob = new Blob(['hello image'], { type: 'image/png' });
      await downloadBlob(testBlob, 'timeline.png');

      expect(mockDownload).toHaveBeenCalledTimes(1);
      expect(mockDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: 'timeline.png',
          saveAs: false
        })
      );
    });

    it('browser.downloads.download 실패 시 앵커 엘리먼트 다운로드로 폴백', async () => {
      const clickSpy = vi.fn();
      const origCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const el = origCreateElement(tag);
        if (tag === 'a') {
          el.click = clickSpy;
        }
        return el;
      });

      vi.stubGlobal('browser', undefined);

      const testBlob = new Blob(['hello image'], { type: 'image/png' });
      await downloadBlob(testBlob, 'fallback-timeline.png');

      expect(clickSpy).toHaveBeenCalled();
    });
  });

  describe('captureElementScreenshot', () => {
    it('hideSelectorDuringCapture 지정 시 캡처 중 대상 요소의 visibility를 hidden으로 설정하고 완료 후 복원', async () => {
      const container = document.createElement('div');
      container.style.width = '200px';
      container.style.height = '100px';

      const btn = document.createElement('button');
      btn.className = 'capture-btn';
      container.appendChild(btn);
      document.body.appendChild(container);

      // In jsdom dimensions are 0 by default, triggering fallback flow
      await captureElementScreenshot(container, {
        filename: 'test.png',
        hideSelectorDuringCapture: '.capture-btn'
      });

      // Visibility must be restored
      expect(btn.style.visibility).toBe('');
      document.body.removeChild(container);
    });

    it('요소의 높이가 뷰포트보다 클 때 다중 슬라이스 캡처 및 임시 스페이서 정상 정리 검증', async () => {
      const container = document.createElement('div');
      container.style.width = '600px';
      container.style.height = '1500px';

      let scrollY = 0;
      vi.spyOn(container, 'getBoundingClientRect').mockImplementation(() => {
        return {
          left: 50,
          top: -scrollY,
          right: 650,
          bottom: 1500 - scrollY,
          width: 600,
          height: 1500,
          x: 50,
          y: -scrollY,
          toJSON: () => {}
        } as DOMRect;
      });

      container.scrollIntoView = vi.fn();
      window.scrollBy = vi.fn((options: any) => {
        scrollY += options?.top || 0;
      }) as any;
      window.scrollTo = vi.fn() as any;

      const mockCapture = vi.fn().mockResolvedValue('data:image/png;base64,slice');
      vi.stubGlobal('browser', {
        tabs: {
          captureVisibleTab: mockCapture
        },
        downloads: {
          download: vi.fn().mockResolvedValue(1)
        }
      });

      const origImage = global.Image;
      class MockImage {
        onload: any = null;
        onerror: any = null;
        crossOrigin = '';
        width = 800;
        height = 600;
        set src(_v: string) {
          setTimeout(() => this.onload && this.onload(), 0);
        }
      }
      global.Image = MockImage as any;

      try {
        document.body.appendChild(container);

        const blob = await captureElementScreenshot(container, {
          filename: 'multislice.png'
        });

        expect(blob).toBeTruthy();
        expect(document.querySelector('[data-capture-spacer]')).toBeNull();
        expect(mockCapture).toHaveBeenCalled();
      } finally {
        global.Image = origImage;
        if (container.parentNode) {
          container.parentNode.removeChild(container);
        }
      }
    });
  });
});
