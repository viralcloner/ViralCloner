const { readKey } = require('./utils');

/**
 * Video Export Queue Manager
 * Prevents multiple video exports from running simultaneously (which would crash
 * due to shared state in videoExporter.js and the single _autoExportResolve in ipcHandlers.js).
 * Allows configurable concurrency (default 1) via automationSettings.videoExportMaxConcurrent.
 */
class VideoExportQueueManager {
    constructor() {
        this.running = 0;
        this.maxConcurrent = 1;
        this.queue = []; // Array of { resolve, reject, fn }
        this._lock = Promise.resolve();
    }

    async _acquireLock() {
        let unlock;
        const willLock = new Promise(resolve => unlock = resolve);
        const lockAcquired = this._lock;
        this._lock = this._lock.then(() => willLock);
        await lockAcquired;
        return unlock;
    }

    async loadSettings() {
        try {
            const settings = (await readKey('automationSettings')) || {};
            this.maxConcurrent = Math.max(1, parseInt(settings.videoExportMaxConcurrent, 10) || 1);
        } catch {
            this.maxConcurrent = 1;
        }
    }

    /**
     * Enqueue a video export operation.
     * @param {Function} exportFn - Async function that performs the export and returns the result
     * @returns {Promise<any>} - Resolves with the export result
     */
    async enqueue(exportFn) {
        const unlock = await this._acquireLock();

        try {
            await this.loadSettings();

            if (this.running < this.maxConcurrent) {
                this.running++;
                console.log(`[VideoExportQueue] Starting export (${this.running}/${this.maxConcurrent} running, ${this.queue.length} queued)`);
                unlock();
                return this._runExport(exportFn);
            }

            console.log(`[VideoExportQueue] Queuing export (${this.running}/${this.maxConcurrent} running, ${this.queue.length + 1} queued)`);

            return new Promise((resolve, reject) => {
                this.queue.push({ resolve, reject, fn: exportFn });
                unlock();
            });
        } catch (err) {
            unlock();
            throw err;
        }
    }

    async _runExport(exportFn) {
        try {
            return await exportFn();
        } finally {
            this.running--;
            this._processNext();
        }
    }

    _processNext() {
        if (this.queue.length === 0 || this.running >= this.maxConcurrent) return;

        const next = this.queue.shift();
        this.running++;
        console.log(`[VideoExportQueue] Dequeuing export (${this.running}/${this.maxConcurrent} running, ${this.queue.length} queued)`);

        this._runExport(next.fn).then(next.resolve, next.reject);
    }

    getStatus() {
        return {
            running: this.running,
            queued: this.queue.length,
            maxConcurrent: this.maxConcurrent
        };
    }
}

const videoExportQueue = new VideoExportQueueManager();

module.exports = { videoExportQueue };
