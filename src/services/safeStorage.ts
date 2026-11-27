/**
 * In-Memory Storage Wrapper for Solar Urja ERP
 *
 * Enforces strict server-authoritative session security:
 * - Never writes authentication tokens, session keys, or user profiles to
 *   localStorage, sessionStorage, window.name, or JS-accessible document.cookie.
 * - Scrubs any legacy client-side keys on removeItem/clear.
 */

class SafeStorageWrapper {
  private memoryStore: Map<string, string> = new Map();
  private storageType: 'localStorage' | 'sessionStorage';

  constructor(type: 'localStorage' | 'sessionStorage') {
    this.storageType = type;
  }

  private removeLegacyBrowserKey(key: string): void {
    if (typeof window === 'undefined') return;
    try {
      window[this.storageType]?.removeItem(key);
    } catch {
      // Ignore restricted storage environments
    }
    try {
      if (window.name && window.name.startsWith('{') && window.name.includes('__rejoy_session__')) {
        const parsed = JSON.parse(window.name);
        if (parsed && typeof parsed === 'object' && parsed.data) {
          delete parsed.data[key];
          window.name = JSON.stringify(parsed);
        }
      }
    } catch {
      // Ignore
    }
    if (typeof document !== 'undefined') {
      try {
        const isHttps = typeof location !== 'undefined' && location.protocol === 'https:';
        if (isHttps) {
          document.cookie = `${key}=; Path=/; Max-Age=0; SameSite=None; Secure; Partitioned`;
        }
        document.cookie = `${key}=; Path=/; Max-Age=0; SameSite=Lax`;
      } catch {
        // Ignore
      }
    }
  }

  public getItem(key: string): string | null {
    const val = this.memoryStore.get(key);
    return val !== undefined && val !== '' ? val : null;
  }

  public setItem(key: string, value: string): void {
    this.memoryStore.set(key, String(value));
  }

  public removeItem(key: string): void {
    this.memoryStore.delete(key);
    this.removeLegacyBrowserKey(key);
  }

  public clear(): void {
    this.memoryStore.clear();
    if (typeof window !== 'undefined') {
      try {
        window[this.storageType]?.removeItem('rejoysolar_auth_token');
        window[this.storageType]?.removeItem('rejoysolar_active_session');
      } catch {
        // Ignore
      }
      try {
        if (window.name && window.name.includes('__rejoy_session__')) {
          window.name = '';
        }
      } catch {
        // Ignore
      }
    }
    this.removeLegacyBrowserKey('rejoysolar_auth_token');
    this.removeLegacyBrowserKey('rejoysolar_active_session');
  }

  public hasItem(key: string): boolean {
    return this.getItem(key) !== null;
  }
}

export const safeStorage = new SafeStorageWrapper('localStorage');
export const safeSessionStorage = new SafeStorageWrapper('sessionStorage');
