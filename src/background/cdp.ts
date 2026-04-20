// CDP 连接管理器 — 封装 chrome.debugger API

export class CdpManager {
  private tabId: number | null = null;

  get isAttached(): boolean {
    return this.tabId !== null;
  }

  get currentTabId(): number | null {
    return this.tabId;
  }

  async attach(tabId: number): Promise<void> {
    if (this.tabId === tabId) return;
    if (this.tabId !== null) {
      await this.detach();
    }
    await chrome.debugger.attach({ tabId }, "1.3");
    this.tabId = tabId;
  }

  async detach(): Promise<void> {
    if (this.tabId === null) return;
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {
      // 可能已经 detach
    }
    this.tabId = null;
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    if (this.tabId === null) {
      throw new Error("CDP not attached. Call attach() first.");
    }
    const result = await chrome.debugger.sendCommand(
      { tabId: this.tabId },
      method,
      params
    );
    return result as T;
  }
}
