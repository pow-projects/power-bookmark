import { writable } from 'svelte/store';
import { checkBookmarksHealth, type HealthCheckResult } from './health/health-checker';

export interface BulkScanState {
  isScanning: boolean;
  progress: number;
  total: number;
  scanningIds: Set<number>;
  healthResults: Map<number, HealthCheckResult>;
  sessionOkIds: Set<number>;
}

const initialState: BulkScanState = {
  isScanning: false,
  progress: 0,
  total: 0,
  scanningIds: new Set<number>(),
  healthResults: new Map<number, HealthCheckResult>(),
  sessionOkIds: new Set<number>()
};

export class BulkScanController {
  private cancelRequested = false;
  public store = writable<BulkScanState>(initialState);

  public async start(
    bookmarkIds: number[],
    onComplete?: (results: HealthCheckResult[]) => void,
    onError?: (error: Error) => void
  ) {
    if (bookmarkIds.length === 0) return;

    this.cancelRequested = false;
    this.store.update((s) => ({
      ...s,
      isScanning: true,
      progress: 0,
      total: bookmarkIds.length,
      scanningIds: new Set<number>()
    }));

    try {
      const results = await checkBookmarksHealth(
        bookmarkIds,
        (current, total) => {
          this.store.update((s) => ({ ...s, progress: current, total }));
        },
        () => this.cancelRequested,
        (id) => {
          this.store.update((s) => {
            const nextScanning = new Set(s.scanningIds);
            nextScanning.add(id);
            return { ...s, scanningIds: nextScanning };
          });
        },
        (batchResults) => {
          this.store.update((s) => {
            const nextResults = new Map(s.healthResults);
            const nextOk = new Set(s.sessionOkIds);
            const nextScanning = new Set(s.scanningIds);

            for (const r of batchResults) {
              nextResults.set(r.bookmarkId, r);
              if (r.status === 'ok') {
                nextOk.add(r.bookmarkId);
              } else {
                nextOk.delete(r.bookmarkId);
              }
              nextScanning.delete(r.bookmarkId);
            }

            return {
              ...s,
              healthResults: nextResults,
              sessionOkIds: nextOk,
              scanningIds: nextScanning
            };
          });
        }
      );

      this.store.update((s) => {
        const nextResults = new Map(s.healthResults);
        for (const r of results) {
          nextResults.set(r.bookmarkId, r);
        }

        const nextOk = new Set(s.sessionOkIds);
        if (!this.cancelRequested) {
          for (const r of results) {
            if (r.status === 'ok') nextOk.add(r.bookmarkId);
            else nextOk.delete(r.bookmarkId);
          }
        }

        return {
          ...s,
          isScanning: false,
          healthResults: nextResults,
          sessionOkIds: nextOk,
          scanningIds: new Set<number>()
        };
      });

      if (onComplete) onComplete(results);
    } catch (e: any) {
      this.store.update((s) => ({
        ...s,
        isScanning: false,
        scanningIds: new Set<number>()
      }));
      if (onError) onError(e);
    }
  }

  public stop() {
    this.cancelRequested = true;
  }

  public clearResult(bookmarkId: number) {
    this.store.update((s) => {
      const nextResults = new Map(s.healthResults);
      nextResults.delete(bookmarkId);
      const nextOk = new Set(s.sessionOkIds);
      nextOk.delete(bookmarkId);
      return {
        ...s,
        healthResults: nextResults,
        sessionOkIds: nextOk
      };
    });
  }

  public reset() {
    this.cancelRequested = true;
    this.store.set(initialState);
  }
}

export const bulkScanController = new BulkScanController();
