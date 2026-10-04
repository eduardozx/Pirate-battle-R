/**
 * Idempotent teardown bag.
 *
 * Every listener, timer and abort handle a component creates is registered here,
 * so unmounting is a single `dispose()` call that is safe to run twice — which is
 * exactly what React StrictMode does in development.
 */
export class Disposables {
  private readonly cleanups: Array<() => void> = [];
  private disposed = false;

  add(cleanup: () => void): void {
    if (this.disposed) {
      // Registering after teardown means the resource already leaked; undo it now.
      cleanup();
      return;
    }
    this.cleanups.push(cleanup);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Reverse order: last registered is first released, mirroring construction.
    for (let i = this.cleanups.length - 1; i >= 0; i -= 1) {
      try {
        (this.cleanups[i] as () => void)();
      } catch (error) {
        console.error('[Disposables] cleanup threw', error);
      }
    }
    this.cleanups.length = 0;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
