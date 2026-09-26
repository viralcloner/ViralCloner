const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const extract = require('extract-zip');
const { app } = require('electron');
const { CleanupManager } = require('./cleanup');
const Database = require('better-sqlite3');

class BackupManager {
    constructor() {
        this.userDataPath = app.getPath('userData');
        this.cleanupManager = new CleanupManager();
    }

    /**
     * Checkpoint a SQLite database to flush WAL into the main .db file.
     * This ensures the .db file is self-contained for backup.
     */
    checkpointDatabase(dbPath) {
        if (!fss.existsSync(dbPath)) return;
        try {
            const db = new Database(dbPath);
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.close();
            console.log(`[BACKUP] Checkpointed: ${path.basename(dbPath)}`);
        } catch (error) {
            console.warn(`[BACKUP] Could not checkpoint ${path.basename(dbPath)}:`, error.message);
        }
    }

    async createFullBackup(savePath, progressCallback = null) {
        try {
            console.log('[BACKUP] Starting backup creation process...');

            const sendProgress = (message, percentage) => {
                console.log(`[BACKUP] ${message} (${percentage}%)`);
                if (progressCallback) progressCallback(message, percentage);
            };

            // Step 1: Run cleanup system to optimize backup size
            sendProgress('Analyzing orphaned profiles...', 5);
            const profilesResult = await this.cleanupManager.cleanupProfiles(false);
            sendProgress(`Profile cleanup done: ${profilesResult?.removed || 0} removed`, 10);

            sendProgress('Cleaning up unreferenced images...', 12);
            const imagesResult = await this.cleanupManager.cleanupImages(false);
            sendProgress(`Image cleanup done: ${imagesResult?.removed || 0} removed`, 15);

            sendProgress('Removing temporary files...', 17);
            const tempResult = await this.cleanupManager.cleanupTempUploads(false);
            sendProgress(`Temp cleanup done: ${tempResult?.removed || 0} removed`, 20);

            // Step 2: Checkpoint all databases to flush WAL
            sendProgress('Checkpointing databases for consistency...', 22);
            const dbFiles = ['storage.db', 'workflows.db', 'analytics.db', 'pinterest.db'];
            for (const dbFile of dbFiles) {
                this.checkpointDatabase(path.join(this.userDataPath, dbFile));
            }
            sendProgress('Database checkpoint complete', 25);

            // Step 3: Create backup archive
            sendProgress('Creating backup archive...', 28);
            const backupInfo = await this.createBackupArchive(savePath, progressCallback);

            console.log('[BACKUP] Backup creation completed successfully');
            sendProgress('Backup completed successfully!', 100);

            return {
                success: true,
                filePath: savePath,
                size: backupInfo.size,
                itemsBackedUp: backupInfo.itemsBackedUp,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('[BACKUP] Error during backup creation:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    createBackupArchive(savePath, progressCallback = null) {
        return new Promise((resolve, reject) => {
            let itemsBackedUp = 0;
            let lastProgressUpdate = Date.now();

            const output = fss.createWriteStream(savePath);
            const archive = archiver('zip', { zlib: { level: 6 } });

            const sendProgress = (message, percentage) => {
                console.log(`[BACKUP] ${message}`);
                if (progressCallback) progressCallback(message, percentage);
            };

            output.on('close', () => {
                console.log('[BACKUP] Archive finalized successfully');
                resolve({
                    size: archive.pointer(),
                    itemsBackedUp
                });
            });

            output.on('error', (err) => {
                console.error('[BACKUP] Output stream error:', err);
                reject(err);
            });

            archive.on('error', (err) => {
                console.error('[BACKUP] Archive error:', err);
                reject(err);
            });

            archive.on('warning', (err) => {
                if (err.code === 'ENOENT') {
                    console.warn('[BACKUP] Archive warning (file not found):', err);
                } else {
                    console.error('[BACKUP] Archive warning:', err);
                    reject(err);
                }
            });

            archive.on('progress', (progress) => {
                const now = Date.now();
                if (now - lastProgressUpdate > 400) {
                    const message = `Compressing: ${progress.entries.processed} files processed`;
                    const percentage = Math.min(30 + Math.floor((progress.entries.processed / Math.max(progress.entries.total, 1)) * 60), 92);
                    sendProgress(message, percentage);
                    lastProgressUpdate = now;
                }
            });

            archive.pipe(output);

            // ─── DATABASES ─────────────────────────────────
            sendProgress('Adding databases to backup...', 30);

            // WAL checkpoint already flushes all data into .db files,
            // so we only need the main database files (no .db-wal or .db-shm)
            const databases = [
                { file: 'storage.db', label: 'storage database' },
                { file: 'workflows.db', label: 'workflows database' },
                { file: 'analytics.db', label: 'analytics database' },
                { file: 'pinterest.db', label: 'pinterest database' }
            ];

            for (const db of databases) {
                const dbPath = path.join(this.userDataPath, db.file);
                if (fss.existsSync(dbPath)) {
                    archive.file(dbPath, { name: `database/${db.file}` });
                    itemsBackedUp++;
                    console.log(`[BACKUP] Added ${db.label}`);
                }
            }

            // ─── CHROME PROFILES ───────────────────────────
            sendProgress('Adding Chrome profiles to backup...', 35);
            const profilesPath = path.join(this.userDataPath, 'profiles');
            if (fss.existsSync(profilesPath)) {
                const excludePatterns = [
                    '**/Cache/**',
                    '**/Code Cache/**',
                    '**/GPUCache/**',
                    '**/Service Worker/CacheStorage/**',
                    '**/Service Worker/ScriptCache/**',
                    '**/blob_storage/**',
                    '**/File System/**',
                    '**/VideoDecodeStats/**',
                    '**/AutofillStrikeDatabase/**',
                    '**/Platform Notifications/**',
                    '**/GCM Store/**',
                    '**/BudgetDatabase/**',
                    '**/reporting/**',
                    '**/optimization_guide_hint_cache_store/**',
                    '**/optimization_guide_model_metadata_store/**',
                    '**/optimization_guide_prediction_model_downloads/**',
                    '**/shared_proto_db/**',
                    '**/DownloadService/**',
                    '**/LOG*',
                    '**/*.log',
                    '**/chromeDLog',
                    '**/chrome_debug.log',
                    '**/BrowserMetrics/**',
                    '**/Crashpad/**',
                    '**/.crc*',
                    '**/MediaCache/**',
                    '**/ShaderCache/**',
                    '**/WebStorage/**',
                    '**/Application Cache/**',
                    '**/DawnCache/**'
                ];

                archive.glob('**/*', {
                    cwd: profilesPath,
                    ignore: excludePatterns,
                    dot: true
                }, {
                    prefix: 'profiles'
                });

                itemsBackedUp++;
                console.log('[BACKUP] Added Chrome profiles (cache excluded, sessions preserved)');
            }

            // ─── GENERATED IMAGES ──────────────────────────
            sendProgress('Adding generated images to backup...', 42);
            const imagesPath = path.join(this.userDataPath, 'Images');
            if (fss.existsSync(imagesPath)) {
                archive.directory(imagesPath, 'images');
                itemsBackedUp++;
                console.log('[BACKUP] Added Images directory');
            }

            // ─── USER UPLOADS (excluding Temp) ─────────────
            sendProgress('Adding user uploads to backup...', 48);
            const uploadsPath = path.join(this.userDataPath, 'Uploads');
            if (fss.existsSync(uploadsPath)) {
                archive.glob('**/*', {
                    cwd: uploadsPath,
                    ignore: ['Temp/**', 'Temp']
                }, {
                    prefix: 'uploads'
                });
                itemsBackedUp++;
                console.log('[BACKUP] Added Uploads directory (excluding Temp)');
            }

            // ─── AUDIO FILES ───────────────────────────────
            sendProgress('Adding audio files to backup...', 52);
            const audioPath = path.join(this.userDataPath, 'Audio');
            if (fss.existsSync(audioPath)) {
                archive.directory(audioPath, 'audio');
                itemsBackedUp++;
                console.log('[BACKUP] Added Audio directory');
            }

            // ─── MUSIC FILES ───────────────────────────────
            sendProgress('Adding music files to backup...', 55);
            const musicsPath = path.join(this.userDataPath, 'Musics');
            if (fss.existsSync(musicsPath)) {
                archive.directory(musicsPath, 'musics');
                itemsBackedUp++;
                console.log('[BACKUP] Added Musics directory');
            }

            // ─── DOWNLOADS ─────────────────────────────────
            sendProgress('Adding downloads to backup...', 58);
            const downloadsPath = path.join(this.userDataPath, 'Downloads');
            if (fss.existsSync(downloadsPath)) {
                archive.directory(downloadsPath, 'downloads');
                itemsBackedUp++;
                console.log('[BACKUP] Added Downloads directory');
            }

            // ─── RECORDINGS ────────────────────────────────
            sendProgress('Adding recordings to backup...', 61);
            const recordingsPath = path.join(this.userDataPath, 'Recordings');
            if (fss.existsSync(recordingsPath)) {
                archive.directory(recordingsPath, 'recordings');
                itemsBackedUp++;
                console.log('[BACKUP] Added Recordings directory');
            }

            // ─── VIDEO MEDIA ───────────────────────────────
            sendProgress('Adding video media to backup...', 64);
            const videoMediaPath = path.join(this.userDataPath, 'VideoMedia');
            if (fss.existsSync(videoMediaPath)) {
                archive.directory(videoMediaPath, 'videomedia');
                itemsBackedUp++;
                console.log('[BACKUP] Added VideoMedia directory');
            }

            // ─── PREVIEW IMAGES ────────────────────────────
            sendProgress('Adding preview images to backup...', 67);
            const previewImagesPath = path.join(this.userDataPath, 'PreviewImages');
            if (fss.existsSync(previewImagesPath)) {
                archive.directory(previewImagesPath, 'previewimages');
                itemsBackedUp++;
                console.log('[BACKUP] Added PreviewImages directory');
            }

            // ─── AUTOMATION THUMBNAILS ─────────────────────
            sendProgress('Adding automation thumbnails to backup...', 70);
            const thumbnailsPath = path.join(this.userDataPath, 'AutomationThumbnails');
            if (fss.existsSync(thumbnailsPath)) {
                archive.directory(thumbnailsPath, 'automationthumbnails');
                itemsBackedUp++;
                console.log('[BACKUP] Added AutomationThumbnails directory');
            }

            // ─── AUTOMATION SCREENSHOTS ────────────────────
            sendProgress('Adding automation screenshots to backup...', 72);
            const screenshotsPath = path.join(this.userDataPath, 'AutomationScreenshots');
            if (fss.existsSync(screenshotsPath)) {
                archive.directory(screenshotsPath, 'automationscreenshots');
                itemsBackedUp++;
                console.log('[BACKUP] Added AutomationScreenshots directory');
            }

            // ─── SESSION FILES ─────────────────────────────
            sendProgress('Adding session files to backup...', 75);
            const sessionPath = path.join(this.userDataPath, 'session.ses');
            if (fss.existsSync(sessionPath)) {
                archive.file(sessionPath, { name: 'sessions/session.ses' });
                itemsBackedUp++;
                console.log('[BACKUP] Added session file');
            }

            // ─── CONFIGURATION FILES ───────────────────────
            sendProgress('Adding configuration files to backup...', 77);
            const bannedPromptsPath = path.join(this.userDataPath, 'banned-prompts.json');
            if (fss.existsSync(bannedPromptsPath)) {
                archive.file(bannedPromptsPath, { name: 'config/banned-prompts.json' });
                itemsBackedUp++;
                console.log('[BACKUP] Added banned-prompts.json');
            }

            // ─── APPLICATION LOGS ──────────────────────────
            sendProgress('Adding application logs to backup...', 80);
            const logsPath = path.join(this.userDataPath, 'Logs');
            if (fss.existsSync(logsPath)) {
                archive.directory(logsPath, 'logs');
                itemsBackedUp++;
                console.log('[BACKUP] Added Logs directory');
            }

            // ─── BROWSER EXTENSION PLUGINS ─────────────────
            sendProgress('Adding browser extension plugins to backup...', 83);
            const pluginsPath = path.join(__dirname, '../plugins');
            if (fss.existsSync(pluginsPath)) {
                archive.directory(pluginsPath, 'plugins');
                itemsBackedUp++;
                console.log('[BACKUP] Added plugins directory (fingerprint, proxy, spy)');
            }

            // ─── METADATA ──────────────────────────────────
            const metadata = {
                version: require('../package.json').version,
                created: new Date().toISOString(),
                platform: process.platform,
                hostname: os.hostname(),
                backupType: 'full',
                itemsIncluded: [
                    'databases (storage.db, workflows.db, analytics.db, pinterest.db)',
                    'chrome profiles (optimized - cache excluded)',
                    'generated images',
                    'user uploads',
                    'audio files (TTS)',
                    'music files',
                    'downloads',
                    'recordings',
                    'video media',
                    'preview images',
                    'automation thumbnails',
                    'automation screenshots',
                    'session files',
                    'configuration (banned-prompts)',
                    'application logs',
                    'browser extension plugins (fingerprint, proxy, spy)'
                ],
                excludedItems: [
                    'vcbrowser (re-downloadable)',
                    'ffmpeg (re-downloadable)',
                    'chromedriver (re-downloadable)',
                    'node_modules',
                    'temp files',
                    'browser cache / GPU cache / media cache / service worker cache'
                ],
                profileOptimization: 'Cache excluded, all session data preserved (Cookies, Login Data, Local/Session Storage, IndexedDB, Preferences, Extensions)',
                totalItemsBacked: itemsBackedUp
            };

            sendProgress('Adding backup metadata...', 93);
            archive.append(JSON.stringify(metadata, null, 2), { name: 'metadata.json' });
            itemsBackedUp++;

            sendProgress('Finalizing and compressing archive...', 95);
            console.log('[BACKUP] Finalizing archive...');
            archive.finalize();
        });
    }

    async restoreFromBackup(backupFilePath, options = {}) {
        try {
            console.log('[RESTORE] Starting restore process...');

            const sendProgress = (message, percentage) => {
                console.log(`[RESTORE] ${message} (${percentage}%)`);
                if (options.progressCallback) {
                    options.progressCallback(message, percentage);
                }
            };

            sendProgress('Starting restore process...', 2);

            // Step 1: Validate backup file
            sendProgress('Validating backup file...', 5);
            const validation = await this.validateBackup(backupFilePath);
            if (!validation.isValid) {
                sendProgress(`Validation failed: ${validation.error}`, 5);
                return {
                    success: false,
                    error: `Invalid backup file: ${validation.error}`
                };
            }
            sendProgress('Backup file validated successfully', 10);

            // Step 2: Create current state backup if requested
            if (options.createCurrentBackup !== false) {
                sendProgress('Creating safety backup of current state...', 12);
                const currentBackupPath = path.join(
                    path.dirname(backupFilePath),
                    `current_state_backup_${Date.now()}.vcbak`
                );
                await this.createFullBackup(currentBackupPath, (msg, pct) => {
                    const mappedPct = Math.floor(12 + (pct * 0.18));
                    sendProgress(`Safety backup: ${msg}`, mappedPct);
                });
                console.log(`[RESTORE] Current state backed up to: ${currentBackupPath}`);
                sendProgress('Safety backup created successfully', 30);
            }

            // Step 3: Clear existing data
            sendProgress('Clearing existing data...', 35);
            await this.clearExistingData(sendProgress);
            sendProgress('Existing data cleared', 45);

            // Step 4: Extract backup
            sendProgress('Extracting backup archive...', 48);
            const tempExtractPath = path.join(this.userDataPath, 'temp_restore_' + Date.now());
            await extract(backupFilePath, { dir: tempExtractPath });
            sendProgress('Backup extracted successfully', 55);

            // Step 5: Restore data
            sendProgress('Restoring data from backup...', 58);
            await this.restoreExtractedData(tempExtractPath, sendProgress);
            sendProgress('Data restored successfully', 95);

            // Always clear the scheduled pins cache — it's a stale snapshot from the
            // source machine and would show incorrect counts until Pinterest is queried.
            this.clearScheduledPinsCache();

            // Step 6: Reset browser profile statuses if machine has changed.
            // Chrome cookies are encrypted with DPAPI (machine-specific), so sessions
            // from the source machine cannot be decrypted on a different machine.
            let browserProfilesReset = false;
            const backupHostname = validation.metadata?.hostname;
            if (backupHostname && backupHostname !== os.hostname()) {
                sendProgress('Different machine detected — resetting browser profile statuses...', 96);
                const resetKeys = this.resetBrowserProfileStatuses();
                browserProfilesReset = resetKeys.length > 0;
                if (browserProfilesReset) {
                    console.log(`[RESTORE] Browser profiles reset due to machine change (${backupHostname} → ${os.hostname()}): ${resetKeys.join(', ')}`);
                }
            }

            // Step 7: Cleanup temporary files
            sendProgress('Cleaning up temporary files...', 97);
            await fs.rm(tempExtractPath, { recursive: true, force: true });

            sendProgress('Restore completed successfully!', 100);
            console.log('[RESTORE] Restore completed successfully');
            return {
                success: true,
                message: 'Backup restored successfully. Please restart the application.',
                metadata: validation.metadata,
                browserProfilesReset
            };
        } catch (error) {
            console.error('[RESTORE] Error during restore:', error);
            if (options.progressCallback) {
                options.progressCallback(`Error: ${error.message}`, 0);
            }
            return {
                success: false,
                error: error.message
            };
        }
    }

    async validateBackup(backupFilePath) {
        try {
            if (!fss.existsSync(backupFilePath)) {
                return { isValid: false, error: 'Backup file does not exist' };
            }

            const tempExtractPath = path.join(this.userDataPath, 'temp_validate_' + Date.now());

            try {
                await extract(backupFilePath, { dir: tempExtractPath });

                const metadataPath = path.join(tempExtractPath, 'metadata.json');
                if (!fss.existsSync(metadataPath)) {
                    return { isValid: false, error: 'Missing metadata.json — not a valid ViralCloner backup' };
                }

                const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));

                const storagePath = path.join(tempExtractPath, 'database', 'storage.db');
                if (!fss.existsSync(storagePath)) {
                    return { isValid: false, error: 'Missing storage.db — backup is corrupted or incomplete' };
                }

                const workflowsPath = path.join(tempExtractPath, 'database', 'workflows.db');
                if (!fss.existsSync(workflowsPath)) {
                    console.warn('[BACKUP] Warning: workflows.db not found in backup (may be from older version)');
                }

                await fs.rm(tempExtractPath, { recursive: true, force: true });

                return {
                    isValid: true,
                    metadata,
                    size: fss.statSync(backupFilePath).size
                };
            } catch (extractError) {
                await fs.rm(tempExtractPath, { recursive: true, force: true }).catch(() => {});
                return { isValid: false, error: 'Failed to extract backup file — file may be corrupted' };
            }
        } catch (error) {
            return { isValid: false, error: error.message };
        }
    }

    async getBackupInfo(backupFilePath) {
        const validation = await this.validateBackup(backupFilePath);
        if (!validation.isValid) {
            return { success: false, error: validation.error };
        }

        const stats = fss.statSync(backupFilePath);

        return {
            success: true,
            info: {
                fileName: path.basename(backupFilePath),
                size: this.formatFileSize(stats.size),
                created: validation.metadata.created,
                version: validation.metadata.version,
                platform: validation.metadata.platform,
                itemsIncluded: validation.metadata.itemsIncluded,
                backupType: validation.metadata.backupType
            }
        };
    }

    async clearExistingData(sendProgress = null) {
        const itemsToDelete = [
            // Databases
            path.join(this.userDataPath, 'storage.db'),
            path.join(this.userDataPath, 'storage.db-wal'),
            path.join(this.userDataPath, 'storage.db-shm'),
            path.join(this.userDataPath, 'workflows.db'),
            path.join(this.userDataPath, 'workflows.db-wal'),
            path.join(this.userDataPath, 'workflows.db-shm'),
            path.join(this.userDataPath, 'analytics.db'),
            path.join(this.userDataPath, 'analytics.db-wal'),
            path.join(this.userDataPath, 'analytics.db-shm'),
            path.join(this.userDataPath, 'pinterest.db'),
            path.join(this.userDataPath, 'pinterest.db-wal'),
            path.join(this.userDataPath, 'pinterest.db-shm'),
            // Directories
            path.join(this.userDataPath, 'profiles'),
            path.join(this.userDataPath, 'Images'),
            path.join(this.userDataPath, 'Uploads'),
            path.join(this.userDataPath, 'Audio'),
            path.join(this.userDataPath, 'Musics'),
            path.join(this.userDataPath, 'Downloads'),
            path.join(this.userDataPath, 'Recordings'),
            path.join(this.userDataPath, 'VideoMedia'),
            path.join(this.userDataPath, 'PreviewImages'),
            path.join(this.userDataPath, 'AutomationThumbnails'),
            path.join(this.userDataPath, 'AutomationScreenshots'),
            // Files
            path.join(this.userDataPath, 'session.ses'),
            path.join(this.userDataPath, 'banned-prompts.json'),
            // Directories
            path.join(this.userDataPath, 'Logs'),
            path.join(__dirname, '../plugins')
        ];

        let cleared = 0;
        for (const item of itemsToDelete) {
            if (fss.existsSync(item)) {
                try {
                    const stat = await fs.stat(item);
                    if (stat.isDirectory()) {
                        await fs.rm(item, { recursive: true, force: true });
                    } else {
                        await fs.unlink(item);
                    }
                    cleared++;
                    console.log(`[RESTORE] Cleared: ${path.basename(item)}`);
                } catch (error) {
                    console.warn(`[RESTORE] Failed to clear ${path.basename(item)}:`, error.message);
                }
            }
        }

        if (sendProgress) sendProgress(`Cleared ${cleared} items`, 42);
    }

    async restoreExtractedData(extractPath, sendProgress = null) {
        const restoreItems = [
            // Databases (only .db files — WAL is checkpointed before backup)
            { from: 'database/storage.db', to: 'storage.db', label: 'storage database' },
            { from: 'database/workflows.db', to: 'workflows.db', label: 'workflows database', optional: true },
            { from: 'database/analytics.db', to: 'analytics.db', label: 'analytics database', optional: true },
            { from: 'database/pinterest.db', to: 'pinterest.db', label: 'pinterest database', optional: true },
            // Chrome Profiles
            { from: 'profiles', to: 'profiles', label: 'Chrome profiles' },
            // Media & Content
            { from: 'images', to: 'Images', label: 'generated images', optional: true },
            { from: 'uploads', to: 'Uploads', label: 'user uploads', optional: true },
            { from: 'audio', to: 'Audio', label: 'audio files', optional: true },
            { from: 'musics', to: 'Musics', label: 'music files', optional: true },
            { from: 'downloads', to: 'Downloads', label: 'downloads', optional: true },
            { from: 'recordings', to: 'Recordings', label: 'recordings', optional: true },
            { from: 'videomedia', to: 'VideoMedia', label: 'video media', optional: true },
            { from: 'previewimages', to: 'PreviewImages', label: 'preview images', optional: true },
            { from: 'automationthumbnails', to: 'AutomationThumbnails', label: 'automation thumbnails', optional: true },
            { from: 'automationscreenshots', to: 'AutomationScreenshots', label: 'automation screenshots', optional: true },
            // Session & Config
            { from: 'sessions/session.ses', to: 'session.ses', label: 'session file', optional: true },
            { from: 'config/banned-prompts.json', to: 'banned-prompts.json', label: 'banned prompts config', optional: true },
            // Logs
            { from: 'logs', to: 'Logs', label: 'application logs', optional: true },
            // Plugins
            { from: 'plugins', to: path.join(__dirname, '../plugins'), label: 'browser extension plugins', isAbsolute: true, optional: true }
        ];

        const totalItems = restoreItems.length;
        let processedItems = 0;
        let restoredItems = 0;

        for (const item of restoreItems) {
            const sourcePath = path.join(extractPath, item.from);
            const destPath = item.isAbsolute ? item.to : path.join(this.userDataPath, item.to);

            if (fss.existsSync(sourcePath)) {
                const progressPct = Math.floor(58 + (processedItems / totalItems) * 35);
                if (sendProgress) {
                    sendProgress(`Restoring ${item.label}...`, progressPct);
                }

                try {
                    const stat = await fs.stat(sourcePath);

                    if (stat.isDirectory()) {
                        await fs.mkdir(path.dirname(destPath), { recursive: true });
                        await this.copyDirectory(sourcePath, destPath);
                    } else {
                        await fs.mkdir(path.dirname(destPath), { recursive: true });
                        await fs.copyFile(sourcePath, destPath);
                    }

                    restoredItems++;
                    console.log(`[RESTORE] Restored: ${item.label}`);
                } catch (copyError) {
                    if (item.optional) {
                        console.warn(`[RESTORE] Skipping optional item (copy failed): ${item.label} - ${copyError.message}`);
                    } else {
                        throw copyError;
                    }
                }
            } else if (!item.optional) {
                console.warn(`[RESTORE] Warning: Required item not found in backup: ${item.from}`);
            }

            processedItems++;
        }

        if (sendProgress) {
            sendProgress(`Restored ${restoredItems} of ${totalItems} items`, 93);
        }
    }

    async copyDirectory(src, dest) {
        await fs.mkdir(dest, { recursive: true });
        const entries = await fs.readdir(src, { withFileTypes: true });

        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);

            if (entry.isDirectory()) {
                await this.copyDirectory(srcPath, destPath);
            } else {
                await fs.copyFile(srcPath, destPath);
            }
        }
    }

    /**
     * After a cross-machine restore, Chrome's DPAPI-encrypted cookies cannot be
     * decrypted on the new machine, so all browser-authenticated profile sessions
     * are invalid. This method resets their status to "disconnected" in the
     * restored storage.db so users immediately know they need to re-authenticate.
     *
     * @returns {string[]} list of storage keys that had profiles reset
     */
    resetBrowserProfileStatuses() {
        const storageDbPath = path.join(this.userDataPath, 'storage.db');
        if (!fss.existsSync(storageDbPath)) return [];

        // Google profiles rely on Chrome session cookies encrypted with Windows DPAPI,
        // which are machine-specific and cannot be decrypted on a different machine.
        // Other browser profiles (Discord, OpenAI, MetaAI, DeepSeek) store their
        // authentication tokens in IndexedDB/localStorage which survive cross-machine copy.
        const browserProfileKeys = [
            'googleProfiles',
        ];

        const resetKeys = [];
        const db = new Database(storageDbPath);

        try {
            for (const key of browserProfileKeys) {
                const row = db.prepare('SELECT value FROM storage WHERE key = ?').get(key);
                if (!row) continue;

                let profiles;
                try {
                    profiles = JSON.parse(row.value);
                } catch (_) {
                    continue;
                }

                if (!profiles || typeof profiles !== 'object') continue;

                let changed = false;
                for (const profileName of Object.keys(profiles)) {
                    if (profiles[profileName]?.status === 'connected') {
                        profiles[profileName].status = 'disconnected';
                        changed = true;
                    }
                }

                if (changed) {
                    db.prepare('INSERT OR REPLACE INTO storage (key, value) VALUES (?, ?)').run(
                        key,
                        JSON.stringify(profiles)
                    );
                    resetKeys.push(key);
                    console.log(`[RESTORE] Reset browser profile statuses for: ${key}`);
                }
            }

        } finally {
            db.close();
        }

        return resetKeys;
    }

    /**
     * Delete the scheduled pins cache from the restored storage.db.
     * The cache is a point-in-time snapshot and will show wrong counts
     * until Pinterest is re-queried, regardless of machine.
     */
    clearScheduledPinsCache() {
        const storageDbPath = path.join(this.userDataPath, 'storage.db');
        if (!fss.existsSync(storageDbPath)) return;
        try {
            const db = new Database(storageDbPath);
            db.prepare('DELETE FROM storage WHERE key = ?').run('scheduledPinsCache');
            db.close();
            console.log('[RESTORE] Cleared scheduledPinsCache (stale snapshot from backup)');
        } catch (err) {
            console.warn('[RESTORE] Could not clear scheduledPinsCache:', err.message);
        }
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    async getBackupEstimateSize() {
        try {
            const categories = {
                database: {
                    name: 'Databases',
                    description: 'Settings, workflows, analytics & all data',
                    paths: [
                        path.join(this.userDataPath, 'storage.db'),
                        path.join(this.userDataPath, 'workflows.db'),
                        path.join(this.userDataPath, 'analytics.db'),
                        path.join(this.userDataPath, 'pinterest.db')
                    ],
                    icon: 'database',
                    compressionRatio: 0.25
                },
                profiles: {
                    name: 'Chrome Profiles',
                    description: 'Sessions, cookies, storage & preferences',
                    path: path.join(this.userDataPath, 'profiles'),
                    icon: 'person',
                    compressionRatio: 0.35,
                    excludePatterns: [
                        'Cache', 'Code Cache', 'GPUCache', 'MediaCache', 'ShaderCache', 'DawnCache',
                        'Service Worker', 'blob_storage', 'File System', 'VideoDecodeStats',
                        'AutofillStrikeDatabase', 'Platform Notifications', 'GCM Store',
                        'BudgetDatabase', 'reporting', 'optimization_guide_hint_cache_store',
                        'optimization_guide_model_metadata_store', 'optimization_guide_prediction_model_downloads',
                        'shared_proto_db', 'DownloadService', 'BrowserMetrics', 'Crashpad',
                        'WebStorage', 'Application Cache'
                    ],
                    useDeepExclusion: true
                },
                images: {
                    name: 'Generated Images',
                    description: 'AI-generated & processed images',
                    path: path.join(this.userDataPath, 'Images'),
                    icon: 'image',
                    compressionRatio: 0.95
                },
                uploads: {
                    name: 'User Uploads',
                    description: 'Uploaded files & media (excluding temp)',
                    path: path.join(this.userDataPath, 'Uploads'),
                    icon: 'cloud_upload',
                    compressionRatio: 0.7,
                    excludePaths: ['Temp']
                },
                audioMusic: {
                    name: 'Audio & Music',
                    description: 'TTS audio files & music tracks',
                    paths: [
                        path.join(this.userDataPath, 'Audio'),
                        path.join(this.userDataPath, 'Musics')
                    ],
                    icon: 'music_note',
                    compressionRatio: 0.95
                },
                downloadsRecordings: {
                    name: 'Downloads & Recordings',
                    description: 'Downloaded media & screen recordings',
                    paths: [
                        path.join(this.userDataPath, 'Downloads'),
                        path.join(this.userDataPath, 'Recordings')
                    ],
                    icon: 'download',
                    compressionRatio: 0.92
                },
                videoMedia: {
                    name: 'Video Media',
                    description: 'Video editor media assets',
                    path: path.join(this.userDataPath, 'VideoMedia'),
                    icon: 'movie',
                    compressionRatio: 0.95
                },
                thumbnailsPreviews: {
                    name: 'Thumbnails & Previews',
                    description: 'Automation thumbnails, screenshots & previews',
                    paths: [
                        path.join(this.userDataPath, 'PreviewImages'),
                        path.join(this.userDataPath, 'AutomationThumbnails'),
                        path.join(this.userDataPath, 'AutomationScreenshots')
                    ],
                    icon: 'photo_library',
                    compressionRatio: 0.85
                },
                sessions: {
                    name: 'Session & Config',
                    description: 'Login sessions & configuration files',
                    paths: [
                        path.join(this.userDataPath, 'session.ses'),
                        path.join(this.userDataPath, 'banned-prompts.json')
                    ],
                    icon: 'key',
                    compressionRatio: 0.3
                },
                logs: {
                    name: 'Application Logs',
                    description: 'Debug & error logs',
                    path: path.join(this.userDataPath, 'Logs'),
                    icon: 'description',
                    compressionRatio: 0.12
                },
                plugins: {
                    name: 'Browser Extensions',
                    description: 'Fingerprint, proxy & spy plugins',
                    path: path.join(__dirname, '../plugins'),
                    icon: 'extension',
                    compressionRatio: 0.3
                }
            };

            const categoryResults = {};
            let totalOriginalSize = 0;
            let totalCompressedSize = 0;

            for (const [key, category] of Object.entries(categories)) {
                let categorySize = 0;
                let categoryExists = false;

                const excludePatterns = category.excludePatterns || category.excludePaths || [];
                const useDeepExclusion = category.useDeepExclusion || false;

                if (category.paths) {
                    for (const filePath of category.paths) {
                        if (fss.existsSync(filePath)) {
                            categoryExists = true;
                            categorySize += await this.getDirectorySize(filePath, excludePatterns, useDeepExclusion);
                        }
                    }
                } else if (category.path) {
                    if (fss.existsSync(category.path)) {
                        categoryExists = true;
                        categorySize = await this.getDirectorySize(category.path, excludePatterns, useDeepExclusion);
                    }
                }

                if (category.sizeMultiplier) {
                    categorySize = Math.floor(categorySize * category.sizeMultiplier);
                }

                const compressedSize = Math.floor(categorySize * category.compressionRatio);

                categoryResults[key] = {
                    name: category.name,
                    description: category.description,
                    icon: category.icon,
                    originalSize: categorySize,
                    compressedSize: compressedSize,
                    originalFormatted: this.formatFileSize(categorySize),
                    compressedFormatted: this.formatFileSize(compressedSize),
                    exists: categoryExists,
                    isEmpty: categorySize === 0,
                    compressionRatio: Math.round((1 - category.compressionRatio) * 100) + '%'
                };

                totalOriginalSize += categorySize;
                totalCompressedSize += compressedSize;
            }

            for (const [key, result] of Object.entries(categoryResults)) {
                result.percentageOfTotal = totalOriginalSize === 0 ? 0 :
                    Math.round((result.originalSize / totalOriginalSize) * 100);
            }

            const overallCompressionRatio = totalOriginalSize === 0 ? 0 :
                Math.round((1 - (totalCompressedSize / totalOriginalSize)) * 100);

            return {
                success: true,
                categories: categoryResults,
                totals: {
                    originalSize: totalOriginalSize,
                    compressedSize: totalCompressedSize,
                    originalFormatted: this.formatFileSize(totalOriginalSize),
                    compressedFormatted: this.formatFileSize(totalCompressedSize),
                    compressionRatio: overallCompressionRatio + '%',
                    savingsFormatted: this.formatFileSize(totalOriginalSize - totalCompressedSize)
                },
                summary: {
                    totalCategories: Object.keys(categories).length,
                    categoriesWithData: Object.values(categoryResults).filter(c => !c.isEmpty).length,
                    largestCategory: this.getLargestCategory(categoryResults),
                    estimatedBackupTime: this.estimateBackupTime(totalOriginalSize)
                }
            };
        } catch (error) {
            console.error('[BACKUP] Error calculating backup estimate:', error);
            return {
                success: false,
                error: error.message,
                categories: {},
                totals: {
                    originalFormatted: 'Unknown',
                    compressedFormatted: 'Unknown',
                    compressionRatio: 'Unknown'
                }
            };
        }
    }

    getLargestCategory(categories) {
        let largest = null;
        let largestSize = 0;

        for (const [key, category] of Object.entries(categories)) {
            if (category.originalSize > largestSize) {
                largestSize = category.originalSize;
                largest = {
                    key: key,
                    name: category.name,
                    size: category.originalFormatted
                };
            }
        }

        return largest;
    }

    estimateBackupTime(totalBytes) {
        const bytesPerSecond = 50 * 1024 * 1024;
        const estimatedSeconds = Math.ceil(totalBytes / bytesPerSecond);

        if (estimatedSeconds < 60) {
            return `~${Math.max(estimatedSeconds, 1)} seconds`;
        } else if (estimatedSeconds < 3600) {
            return `~${Math.ceil(estimatedSeconds / 60)} minutes`;
        } else {
            return `~${Math.ceil(estimatedSeconds / 3600)} hours`;
        }
    }

    async getDirectorySize(dirPath, excludePatterns = [], useDeepExclusion = false) {
        try {
            const stat = await fs.stat(dirPath);

            if (stat.isFile()) {
                return stat.size;
            }

            let totalSize = 0;
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const shouldExclude = excludePatterns.some(pattern => {
                    if (entry.name === pattern) return true;
                    if (useDeepExclusion && entry.name.includes(pattern)) return true;
                    if (pattern === 'LOG' && (entry.name.startsWith('LOG') || entry.name.endsWith('.log'))) return true;
                    return false;
                });

                if (shouldExclude) {
                    continue;
                }

                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    totalSize += await this.getDirectorySize(fullPath, excludePatterns, useDeepExclusion);
                } else {
                    try {
                        const fileStat = await fs.stat(fullPath);
                        totalSize += fileStat.size;
                    } catch {
                        // Skip files we can't access
                    }
                }
            }

            return totalSize;
        } catch (error) {
            return 0;
        }
    }
}

module.exports = { BackupManager };
