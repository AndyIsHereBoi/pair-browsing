// IndexedDB storage service for conversation history
class ConversationStorage {
  constructor() {
    this.DB_NAME = 'conversationDB';
    this.STORE_NAME = 'conversations';
    this.DISPLAY_STORE_NAME = 'displayMessages';
    this.VERSION = 2;
    this.db = null;
  }

  async init() {
    if (this.db) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.VERSION);

      request.onerror = () => {
        console.error('Failed to open database');
        reject(request.error);
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME, { keyPath: 'timestamp' });
        }
        if (!db.objectStoreNames.contains(this.DISPLAY_STORE_NAME)) {
          db.createObjectStore(this.DISPLAY_STORE_NAME, { keyPath: 'timestamp' });
        }
      };
    });
  }

  async clearHistory() {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(
        [this.STORE_NAME, this.DISPLAY_STORE_NAME],
        'readwrite'
      );
      const store = transaction.objectStore(this.STORE_NAME);
      const displayStore = transaction.objectStore(this.DISPLAY_STORE_NAME);
      const request = store.clear();
      const displayRequest = displayStore.clear();

      transaction.oncomplete = () => {
        console.log('Conversation history cleared');
        resolve();
      };

      transaction.onerror = () => {
        console.error('Failed to clear history');
        reject(request.error || displayRequest.error);
      };
    });
  }

  async addEntry(entry) {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);
      const enhancedEntry = {
        ...entry,
        timestamp: Date.now()
      };
      const request = store.add(enhancedEntry);

      request.onsuccess = () => {
        console.log('Entry added to history');
        resolve();
      };

      request.onerror = () => {
        console.error('Failed to add entry');
        reject(request.error);
      };
    });
  }

  async getAllHistory() {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.STORE_NAME], 'readonly');
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        // Sort by timestamp and remove timestamp from returned objects
        const history = request.result
          .sort((a, b) => a.timestamp - b.timestamp)
          .map(({ timestamp, ...entry }) => entry);
        resolve(history);
      };

      request.onerror = () => {
        console.error('Failed to get history');
        reject(request.error);
      };
    });
  }

  // Display history is separate from model-context history. It only carries the
  // user prompts and the assistant's visible replies, so the chat can be restored
  // in the UI without polluting the model's context window.
  async addDisplayEntry(entry) {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.DISPLAY_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(this.DISPLAY_STORE_NAME);
      const request = store.add({
        role: entry.role,
        content: entry.content,
        timestamp: Date.now(),
      });
      request.onsuccess = () => resolve();
      request.onerror = () => {
        console.error('Failed to add display entry');
        reject(request.error);
      };
    });
  }

  async getDisplayHistory() {
    await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.DISPLAY_STORE_NAME], 'readonly');
      const store = transaction.objectStore(this.DISPLAY_STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        const history = request.result
          .sort((a, b) => a.timestamp - b.timestamp)
          .map(({ timestamp, ...entry }) => entry);
        resolve(history);
      };
      request.onerror = () => {
        console.error('Failed to get display history');
        reject(request.error);
      };
    });
  }
}

// Export singleton instance
export const conversationStorage = new ConversationStorage(); 