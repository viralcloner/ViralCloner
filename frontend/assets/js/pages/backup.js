class BackupManager {
    constructor() {
        this.selectedBackupFile = null;
        this.isOperationInProgress = false;
        this.estimateDetailsVisible = false;
        this.initializeEventListeners();
        this.setupProgressListeners();
    }

    destroy() {
        // Remove IPC listeners if needed
        this.destroyed = true;
    }

    // ═══════════════════════════════════════
    //  EVENT LISTENERS
    // ═══════════════════════════════════════

    initializeEventListeners() {
        console.log('[BACKUP] Setting up event listeners...');

        try {
            // Backup buttons
            const getEstimateBtn = document.getElementById('getEstimateBtn');
            const createBackupBtn = document.getElementById('createBackupBtn');

            if (getEstimateBtn) {
                getEstimateBtn.addEventListener('click', () => this.getBackupEstimate());
            }
            if (createBackupBtn) {
                createBackupBtn.addEventListener('click', () => this.createBackup());
            }

            // Restore buttons
            const selectBackupBtn = document.getElementById('selectBackupBtn');
            const restoreBackupBtn = document.getElementById('restoreBackupBtn');

            if (selectBackupBtn) {
                selectBackupBtn.addEventListener('click', () => this.selectBackupFile());
            }
            if (restoreBackupBtn) {
                restoreBackupBtn.addEventListener('click', () => this.showWarningModal());
            }

            // File drop zone
            const dropZone = document.getElementById('fileDropZone');
            if (dropZone) {
                dropZone.addEventListener('click', (e) => {
                    // Avoid triggering when clicking the button itself
                    if (e.target.closest('#selectBackupBtn')) return;
                    this.selectBackupFile();
                });
                dropZone.addEventListener('dragover', (e) => this.handleDragOver(e));
                dropZone.addEventListener('dragleave', (e) => this.handleDragLeave(e));
                dropZone.addEventListener('drop', (e) => this.handleFileDrop(e));
            }

            // Toggle estimate details
            const toggleDetailsBtn = document.getElementById('toggleDetailsBtn');
            if (toggleDetailsBtn) {
                toggleDetailsBtn.addEventListener('click', () => this.toggleEstimateDetails());
            }

            // Warning modal checkboxes
            const checkboxes = ['confirmUnderstand', 'confirmBackup', 'confirmRestart'];
            checkboxes.forEach(id => {
                const checkbox = document.getElementById(id);
                if (checkbox) {
                    checkbox.addEventListener('change', () => this.updateConfirmButton());
                }
            });

            const confirmRestoreBtn = document.getElementById('confirmRestoreBtn');
            if (confirmRestoreBtn) {
                confirmRestoreBtn.addEventListener('click', () => this.confirmRestore());
            }

            // Profile cache cleaner button
            const cleanProfileCachesBtn = document.getElementById('cleanProfileCachesBtn');
            if (cleanProfileCachesBtn) {
                cleanProfileCachesBtn.addEventListener('click', () => this.cleanProfileCaches());
            }

            console.log('[BACKUP] All event listeners set up successfully');
        } catch (error) {
            console.error('[BACKUP] Error setting up event listeners:', error);
        }
    }

    setupProgressListeners() {
        window.electronAPI.onBackupProgress((data) => {
            if (this.destroyed) return;
            this.updateProgress('backup', data.message, data.percentage);
        });

        window.electronAPI.onRestoreProgress((data) => {
            if (this.destroyed) return;
            this.updateProgress('restore', data.message, data.percentage);
        });
    }

    // ═══════════════════════════════════════
    //  BACKUP ESTIMATE
    // ═══════════════════════════════════════

    async getBackupEstimate() {
        if (this.isOperationInProgress) return;

        try {
            this.setButtonLoading('getEstimateBtn', true);

            const result = await window.electronAPI.getBackupEstimate();

            if (result.success) {
                this.showBackupEstimate(result.estimate);
            } else {
                this.showError(window.I18n?.t('backup.estimate_failed') || 'Failed to get backup estimate: ' + result.error);
            }
        } catch (error) {
            this.showError(window.I18n?.t('backup.estimate_error') || 'Error getting backup estimate: ' + error.message);
        } finally {
            this.setButtonLoading('getEstimateBtn', false);
        }
    }

    showBackupEstimate(estimate) {
        if (!estimate.success) {
            this.showError('Failed to get backup estimate: ' + (estimate.error || 'Unknown error'));
            return;
        }

        // Update summary stats
        document.getElementById('totalOriginalSize').textContent = estimate.totals.originalFormatted;
        document.getElementById('totalCompressedSize').textContent = estimate.totals.compressedFormatted;
        document.getElementById('totalSavings').textContent = estimate.totals.savingsFormatted;

        // Update info line
        document.getElementById('categoriesWithData').textContent = estimate.summary.categoriesWithData;
        document.getElementById('totalCategories').textContent = estimate.summary.totalCategories;
        document.getElementById('estimatedTime').textContent = estimate.summary.estimatedBackupTime;

        // Largest category
        const largestCategory = estimate.summary.largestCategory;
        const largestText = largestCategory ?
            `${largestCategory.name} (${largestCategory.size})` :
            (window.I18n?.t('backup.no_data') || 'No data found');
        document.getElementById('largestCategory').textContent = largestText;

        // Generate category breakdown
        this.generateCategoryList(estimate.categories);

        // Show estimate panel
        document.getElementById('backupEstimate').style.display = 'block';
    }

    generateCategoryList(categories) {
        const categoryList = document.getElementById('categoryList');
        categoryList.innerHTML = '';

        const sorted = Object.entries(categories).sort(
            ([, a], [, b]) => b.originalSize - a.originalSize
        );

        const maxSize = sorted.length > 0 ? sorted[0][1].originalSize : 1;

        sorted.forEach(([key, category]) => {
            categoryList.appendChild(this.createCategoryElement(key, category, maxSize));
        });
    }

    createCategoryElement(key, category, maxSize) {
        const div = document.createElement('div');

        let categoryClass = 'category-item';
        if (category.isEmpty) {
            categoryClass += ' empty';
        } else if (category.originalSize === maxSize && maxSize > 0) {
            categoryClass += ' large';
        } else {
            categoryClass += ' has-data';
        }

        const progressWidth = maxSize > 0 ? Math.max((category.originalSize / maxSize) * 100, 2) : 0;

        // Map backend icon names to Material Icons
        const iconName = category.icon || 'folder';

        div.className = categoryClass;
        div.innerHTML = `
            <div class="category-header">
                <div class="category-title">
                    <span class="material-icons category-icon">${iconName}</span>
                    <div>
                        <div class="fw-bold">${category.name}</div>
                        <small class="category-desc">${category.description}</small>
                    </div>
                </div>
                <div class="category-size-info">
                    <div class="category-size">
                        ${category.isEmpty ? (window.I18n?.t('backup.empty') || 'Empty') : category.originalFormatted}
                    </div>
                    ${!category.isEmpty ? `
                        <small class="category-compressed">
                            → ${category.compressedFormatted}
                            <span class="compression-badge">${category.compressionRatio}</span>
                        </small>
                    ` : ''}
                </div>
            </div>

            ${!category.isEmpty ? `
                <div class="category-details">
                    <div class="category-meta">
                        <span>${category.percentageOfTotal}% of total</span>
                        <span class="category-status available">${category.exists ? '✓ Available' : '✗ Missing'}</span>
                    </div>
                    <div class="category-progress">
                        <div class="category-progress-bar" style="width: ${progressWidth}%"></div>
                    </div>
                </div>
            ` : `
                <div class="category-details">
                    <span class="category-status empty">${category.exists ?
                        (window.I18n?.t('backup.dir_empty') || 'Directory exists but contains no data') :
                        (window.I18n?.t('backup.dir_missing') || 'Directory does not exist')}</span>
                </div>
            `}
        `;

        return div;
    }

    toggleEstimateDetails() {
        const details = document.getElementById('estimateDetails');
        const toggleIcon = document.querySelector('#toggleDetailsBtn .material-icons');
        const toggleText = document.getElementById('toggleText');

        this.estimateDetailsVisible = !this.estimateDetailsVisible;

        if (this.estimateDetailsVisible) {
            details.style.display = 'block';
            if (toggleIcon) toggleIcon.textContent = 'expand_less';
            if (toggleText) toggleText.textContent = window.I18n?.t('backup.hide_details') || 'Hide Details';
        } else {
            details.style.display = 'none';
            if (toggleIcon) toggleIcon.textContent = 'expand_more';
            if (toggleText) toggleText.textContent = window.I18n?.t('backup.show_details') || 'Show Details';
        }
    }

    // ═══════════════════════════════════════
    //  CREATE BACKUP
    // ═══════════════════════════════════════

    async createBackup() {
        if (this.isOperationInProgress) return;

        try {
            this.isOperationInProgress = true;
            this.setButtonLoading('createBackupBtn', true);
            this.showProgress('backup');

            const result = await window.electronAPI.createFullBackup();

            if (result.success) {
                this.hideProgress('backup');
                const msg = (window.I18n?.t('backup.backup_success_detail', {
                    path: result.filePath,
                    size: this.formatBytes(result.size),
                    items: result.itemsBackedUp
                })) || `Backup created successfully!\n\nFile: ${result.filePath}\nSize: ${this.formatBytes(result.size)}\nItems: ${result.itemsBackedUp}`;
                this.showSuccess(msg);
            } else {
                this.hideProgress('backup');
                this.showError(result.error || (window.I18n?.t('backup.backup_failed') || 'Failed to create backup'));
            }
        } catch (error) {
            this.hideProgress('backup');
            this.showError((window.I18n?.t('backup.backup_error') || 'Error creating backup') + ': ' + error.message);
        } finally {
            this.isOperationInProgress = false;
            this.setButtonLoading('createBackupBtn', false);
        }
    }

    // ═══════════════════════════════════════
    //  RESTORE — FILE SELECTION
    // ═══════════════════════════════════════

    async selectBackupFile() {
        if (this.isOperationInProgress) return;

        try {
            const result = await window.electronAPI.selectBackupFile();
            if (result.success) {
                await this.validateAndShowBackupInfo(result.filePath);
            }
        } catch (error) {
            this.showError((window.I18n?.t('backup.select_error') || 'Error selecting backup file') + ': ' + error.message);
        }
    }

    async validateAndShowBackupInfo(filePath) {
        try {
            this.setButtonLoading('selectBackupBtn', true);

            const validation = await window.electronAPI.validateBackupFile(filePath);
            if (!validation.isValid) {
                this.showError((window.I18n?.t('backup.invalid_file') || 'Invalid backup file') + ': ' + validation.error);
                return;
            }

            const infoResult = await window.electronAPI.getBackupInfo(filePath);
            if (infoResult.success) {
                this.selectedBackupFile = filePath;
                this.showBackupInfo(infoResult.info);
                document.getElementById('restoreBackupBtn').disabled = false;
            } else {
                this.showError((window.I18n?.t('backup.read_info_failed') || 'Failed to read backup info') + ': ' + infoResult.error);
            }
        } catch (error) {
            this.showError((window.I18n?.t('backup.validate_error') || 'Error validating backup file') + ': ' + error.message);
        } finally {
            this.setButtonLoading('selectBackupBtn', false);
        }
    }

    showBackupInfo(info) {
        document.getElementById('backupFileName').textContent = info.fileName;
        document.getElementById('backupFileSize').textContent = info.size;
        document.getElementById('backupCreated').textContent = new Date(info.created).toLocaleString();
        document.getElementById('backupVersion').textContent = info.version;
        document.getElementById('backupInfo').style.display = 'block';

        // Update drop zone to show selected file
        const dropZone = document.getElementById('fileDropZone');
        dropZone.classList.add('file-selected');
        dropZone.innerHTML = `
            <span class="material-icons drop-icon selected">description</span>
            <h5>${info.fileName}</h5>
            <p>${info.size} &middot; ${new Date(info.created).toLocaleDateString()}</p>
            <button class="btn-backup-secondary" id="selectBackupBtn">
                <span class="material-icons">folder_open</span>
                <span data-i18n="backup.choose_different">${window.I18n?.t('backup.choose_different') || 'Choose Different File'}</span>
            </button>
        `;

        // Re-attach listener
        document.getElementById('selectBackupBtn').addEventListener('click', () => this.selectBackupFile());
    }

    handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        const dropZone = document.getElementById('fileDropZone');
        if (dropZone) dropZone.classList.add('drag-over');
    }

    handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        const dropZone = document.getElementById('fileDropZone');
        if (dropZone) dropZone.classList.remove('drag-over');
    }

    async handleFileDrop(e) {
        e.preventDefault();
        e.stopPropagation();

        const dropZone = document.getElementById('fileDropZone');
        if (dropZone) dropZone.classList.remove('drag-over');

        if (this.isOperationInProgress) return;

        const files = e.dataTransfer.files;
        if (files.length === 1) {
            const file = files[0];
            if (file.name.endsWith('.vcbak')) {
                await this.validateAndShowBackupInfo(file.path);
            } else {
                this.showError(window.I18n?.t('backup.invalid_extension') || 'Please select a valid .vcbak backup file');
            }
        }
    }

    // ═══════════════════════════════════════
    //  RESTORE — WARNING & CONFIRM
    // ═══════════════════════════════════════

    showWarningModal() {
        if (!this.selectedBackupFile) {
            this.showError(window.I18n?.t('backup.no_file_selected') || 'Please select a backup file first');
            return;
        }

        // Reset checkboxes
        ['confirmUnderstand', 'confirmBackup', 'confirmRestart'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.checked = false;
        });
        this.updateConfirmButton();

        const modal = new bootstrap.Modal(document.getElementById('warningModal'));
        modal.show();
    }

    updateConfirmButton() {
        const allChecked = ['confirmUnderstand', 'confirmBackup', 'confirmRestart']
            .every(id => document.getElementById(id)?.checked);
        const btn = document.getElementById('confirmRestoreBtn');
        if (btn) btn.disabled = !allChecked;
    }

    async confirmRestore() {
        if (!this.selectedBackupFile || this.isOperationInProgress) return;

        try {
            this.isOperationInProgress = true;

            const modal = bootstrap.Modal.getInstance(document.getElementById('warningModal'));
            if (modal) modal.hide();

            this.showProgress('restore');

            const result = await window.electronAPI.restoreFromBackup(this.selectedBackupFile, {
                createCurrentBackup: true
            });

            this.hideProgress('restore');

            if (result.success) {
                let msg;
                if (result.browserProfilesReset) {
                    msg = window.I18n?.t('backup.restore_success_new_machine') ||
                        'Backup restored successfully!\n\nThe application will restart automatically to load the restored data.\n\nA backup of your previous state has been created automatically.\n\n[!] New Machine Detected: Google accounts have been marked as disconnected because Chrome session cookies are encrypted per-machine. Please reconnect them in Settings after the restart.';
                } else {
                    msg = window.I18n?.t('backup.restore_success_detail') ||
                        'Backup restored successfully!\n\nThe application will restart automatically to load the restored data.\n\nA backup of your previous state has been created automatically.';
                }
                this.showSuccess(msg, () => {
                    window.electronAPI.restartApp();
                });
            } else {
                this.showError((window.I18n?.t('backup.restore_failed') || 'Failed to restore backup') + ': ' + result.error);
            }
        } catch (error) {
            this.hideProgress('restore');
            this.showError((window.I18n?.t('backup.restore_error') || 'Error during restore') + ': ' + error.message);
        } finally {
            this.isOperationInProgress = false;
        }
    }

    // ═══════════════════════════════════════
    //  PROFILE CACHE CLEANER
    // ═══════════════════════════════════════

    async cleanProfileCaches() {
        const btn = document.getElementById('cleanProfileCachesBtn');
        const resultEl = document.getElementById('profileCacheResult');
        const resultText = document.getElementById('profileCacheResultText');
        const resultIcon = document.getElementById('profileCacheResultIcon');

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="material-icons" style="animation:spin 1s linear infinite">sync</span> <span>Cleaning...</span>';
        }
        if (resultEl) resultEl.style.display = 'none';

        try {
            const result = await window.electronAPI.cleanProfileCaches();

            if (resultEl && resultText && resultIcon) {
                resultEl.style.display = 'block';
                if (result && result.success) {
                    resultIcon.textContent = 'check_circle';
                    resultIcon.style.color = '#22c55e';
                    resultText.textContent = `Done! Cleaned ${result.profilesCleaned || 0} profile(s) and freed ${result.freedFormatted || '0 B'}.`;
                } else {
                    resultIcon.textContent = 'error';
                    resultIcon.style.color = '#ef4444';
                    resultText.textContent = `Error: ${result?.error || 'Unknown error'}`;
                }
            }
        } catch (err) {
            if (resultEl && resultText && resultIcon) {
                resultEl.style.display = 'block';
                resultIcon.textContent = 'error';
                resultIcon.style.color = '#ef4444';
                resultText.textContent = `Error: ${err.message}`;
            }
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<span class="material-icons">delete_sweep</span> <span>Clean Profile Caches</span>';
            }
        }
    }

    // ═══════════════════════════════════════
    //  PROGRESS & ACTIVITY LOG
    // ═══════════════════════════════════════

    showProgress(type) {
        const container = document.getElementById(`${type}Progress`);
        if (!container) return;
        container.style.display = 'block';

        // Reset
        const bar = document.getElementById(`${type}ProgressBar`);
        const pct = document.getElementById(`${type}ProgressPercentage`);
        const step = document.getElementById(`${type}CurrentStep`);
        const log = document.getElementById(`${type}ActivityLog`);

        if (bar) bar.style.width = '0%';
        if (pct) pct.textContent = '0%';
        if (step) step.textContent = window.I18n?.t('backup.preparing') || 'Preparing';
        if (log) log.innerHTML = '';

        this.addLogEntry(type, window.I18n?.t('backup.operation_started') || 'Operation started...', 'info');

        // Disable buttons
        if (type === 'backup') {
            this.setDisabled('createBackupBtn', true);
            this.setDisabled('getEstimateBtn', true);
        } else {
            this.setDisabled('restoreBackupBtn', true);
            this.setDisabled('selectBackupBtn', true);
        }
    }

    hideProgress(type) {
        const container = document.getElementById(`${type}Progress`);
        if (container) container.style.display = 'none';

        // Re-enable buttons
        if (type === 'backup') {
            this.setDisabled('createBackupBtn', false);
            this.setDisabled('getEstimateBtn', false);
        } else {
            this.setDisabled('restoreBackupBtn', false);
            this.setDisabled('selectBackupBtn', false);
        }
    }

    updateProgress(type, message, percentage) {
        const bar = document.getElementById(`${type}ProgressBar`);
        const pct = document.getElementById(`${type}ProgressPercentage`);
        const step = document.getElementById(`${type}CurrentStep`);
        const title = document.getElementById(`${type}ProgressTitle`);

        if (percentage !== null && percentage !== undefined) {
            if (bar) bar.style.width = `${percentage}%`;
            if (pct) pct.textContent = `${percentage}%`;
        }

        if (message) {
            // Update phase title
            if (title) {
                const phase = this.getPhaseFromMessage(message);
                title.textContent = phase;
            }

            // Update step indicator
            if (step) {
                step.textContent = this.getStepFromMessage(message);
            }

            // Add to activity log
            const logType = this.getLogTypeFromMessage(message);
            this.addLogEntry(type, message, logType);
        }
    }

    addLogEntry(type, message, logType = 'info') {
        const log = document.getElementById(`${type}ActivityLog`);
        if (!log) return;

        const entry = document.createElement('div');
        entry.className = `log-entry log-${logType}`;

        const time = new Date();
        const timestamp = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`;

        // Icon per log type
        const icons = {
            info: 'info',
            success: 'check_circle',
            warning: 'warning',
            error: 'error',
            progress: 'sync'
        };

        entry.innerHTML = `<span class="log-time">${timestamp}</span><span class="material-icons log-icon">${icons[logType] || 'info'}</span><span class="log-message">${this.escapeHtml(message)}</span>`;
        log.appendChild(entry);

        // Auto-scroll to bottom
        log.scrollTop = log.scrollHeight;
    }

    getLogTypeFromMessage(message) {
        const lower = message.toLowerCase();
        if (lower.includes('error') || lower.includes('failed')) return 'error';
        if (lower.includes('completed') || lower.includes('success') || lower.includes('finalized')) return 'success';
        if (lower.includes('warning') || lower.includes('skipping')) return 'warning';
        if (lower.includes('archiving files:')) return 'progress';
        return 'info';
    }

    getPhaseFromMessage(message) {
        const m = message.toLowerCase();

        // Cleanup phases
        if (m.includes('analyzing') || m.includes('orphaned')) return window.I18n?.t('backup.phase_optimizing') || 'Optimizing Data...';
        if (m.includes('unreferenced') || m.includes('cleaning')) return window.I18n?.t('backup.phase_cleaning') || 'Cleaning Up...';
        if (m.includes('temporary files') || m.includes('removing')) return window.I18n?.t('backup.phase_removing_temp') || 'Removing Temp Files...';

        // Checkpoint
        if (m.includes('checkpoint') || m.includes('wal')) return window.I18n?.t('backup.phase_checkpoint') || 'Database Checkpoint...';

        // Archive phases
        if (m.includes('preparing') || m.includes('archive')) return window.I18n?.t('backup.phase_preparing') || 'Preparing Archive...';
        if (m.includes('database')) return window.I18n?.t('backup.phase_databases') || 'Adding Databases...';
        if (m.includes('chrome profile') || m.includes('profiles to backup')) return window.I18n?.t('backup.phase_profiles') || 'Adding Chrome Profiles...';
        if (m.includes('generated images')) return window.I18n?.t('backup.phase_images') || 'Adding Images...';
        if (m.includes('uploads')) return window.I18n?.t('backup.phase_uploads') || 'Adding Uploads...';
        if (m.includes('audio')) return window.I18n?.t('backup.phase_audio') || 'Adding Audio...';
        if (m.includes('music')) return window.I18n?.t('backup.phase_music') || 'Adding Music...';
        if (m.includes('downloads')) return window.I18n?.t('backup.phase_downloads') || 'Adding Downloads...';
        if (m.includes('recordings')) return window.I18n?.t('backup.phase_recordings') || 'Adding Recordings...';
        if (m.includes('video media')) return window.I18n?.t('backup.phase_videomedia') || 'Adding Video Media...';
        if (m.includes('preview images')) return window.I18n?.t('backup.phase_previews') || 'Adding Previews...';
        if (m.includes('thumbnails')) return window.I18n?.t('backup.phase_thumbnails') || 'Adding Thumbnails...';
        if (m.includes('screenshots')) return window.I18n?.t('backup.phase_screenshots') || 'Adding Screenshots...';
        if (m.includes('session')) return window.I18n?.t('backup.phase_sessions') || 'Adding Sessions...';
        if (m.includes('configuration') || m.includes('config')) return window.I18n?.t('backup.phase_config') || 'Adding Configuration...';
        if (m.includes('logs')) return window.I18n?.t('backup.phase_logs') || 'Adding Logs...';
        if (m.includes('plugin') || m.includes('extension')) return window.I18n?.t('backup.phase_plugins') || 'Adding Plugins...';
        if (m.includes('archiving')) return window.I18n?.t('backup.phase_compressing') || 'Compressing Files...';
        if (m.includes('finalizing') || m.includes('compressing')) return window.I18n?.t('backup.phase_finalizing') || 'Finalizing Backup...';
        if (m.includes('completed') || m.includes('success')) return window.I18n?.t('backup.phase_complete') || 'Complete!';

        // Restore phases
        if (m.includes('validating')) return window.I18n?.t('backup.phase_validating') || 'Validating Backup...';
        if (m.includes('backing up current state')) return window.I18n?.t('backup.phase_pre_backup') || 'Backing Up Current State...';
        if (m.includes('clearing') || m.includes('existing data')) return window.I18n?.t('backup.phase_clearing') || 'Clearing Existing Data...';
        if (m.includes('extracting')) return window.I18n?.t('backup.phase_extracting') || 'Extracting Backup...';
        if (m.includes('restoring')) return window.I18n?.t('backup.phase_restoring') || 'Restoring Data...';
        if (m.includes('restore completed')) return window.I18n?.t('backup.phase_restore_complete') || 'Restore Complete!';

        return window.I18n?.t('backup.phase_processing') || 'Processing...';
    }

    getStepFromMessage(message) {
        const m = message.toLowerCase();

        // Backup step mapping
        if (m.includes('analyzing') || m.includes('orphaned')) return 'Cleanup 1/3';
        if (m.includes('unreferenced') || m.includes('cleaning')) return 'Cleanup 2/3';
        if (m.includes('temporary') || m.includes('removing')) return 'Cleanup 3/3';
        if (m.includes('checkpoint') || m.includes('wal')) return 'Database prep';
        if (m.includes('database')) return 'Archiving databases';
        if (m.includes('chrome profile') || m.includes('profiles to backup')) return 'Archiving profiles';
        if (m.includes('generated images')) return 'Archiving images';
        if (m.includes('uploads')) return 'Archiving uploads';
        if (m.includes('audio')) return 'Archiving audio';
        if (m.includes('music')) return 'Archiving music';
        if (m.includes('downloads')) return 'Archiving downloads';
        if (m.includes('recordings')) return 'Archiving recordings';
        if (m.includes('video media')) return 'Archiving video media';
        if (m.includes('preview images')) return 'Archiving previews';
        if (m.includes('thumbnails')) return 'Archiving thumbnails';
        if (m.includes('screenshots')) return 'Archiving screenshots';
        if (m.includes('session')) return 'Archiving sessions';
        if (m.includes('configuration') || m.includes('config')) return 'Archiving config';
        if (m.includes('logs')) return 'Archiving logs';
        if (m.includes('plugin') || m.includes('extension')) return 'Archiving plugins';
        if (m.includes('archiving files')) return 'Compressing';
        if (m.includes('finalizing')) return 'Finalizing';
        if (m.includes('completed')) return 'Done';

        // Restore step mapping
        if (m.includes('validating')) return 'Validating';
        if (m.includes('backing up current')) return 'Safety backup';
        if (m.includes('clearing')) return 'Clearing data';
        if (m.includes('extracting')) return 'Extracting';
        if (m.includes('restoring')) return 'Restoring';
        if (m.includes('restore completed')) return 'Done';

        return 'Processing';
    }

    // ═══════════════════════════════════════
    //  UI HELPERS
    // ═══════════════════════════════════════

    setButtonLoading(buttonId, loading) {
        const button = document.getElementById(buttonId);
        if (!button) return;

        const icon = button.querySelector('.material-icons');

        if (loading) {
            button.disabled = true;
            button.classList.add('loading');
            if (icon) {
                icon.dataset.originalIcon = icon.textContent;
                icon.textContent = 'sync';
                icon.classList.add('spinning');
            }
        } else {
            button.disabled = false;
            button.classList.remove('loading');
            if (icon) {
                icon.textContent = icon.dataset.originalIcon || icon.textContent;
                icon.classList.remove('spinning');
            }
        }
    }

    setDisabled(buttonId, disabled) {
        const btn = document.getElementById(buttonId);
        if (btn) btn.disabled = disabled;
    }

    showSuccess(message, callback = null) {
        document.getElementById('successMessage').textContent = message;
        const modal = new bootstrap.Modal(document.getElementById('successModal'));

        if (callback) {
            document.getElementById('successModal').addEventListener('hidden.bs.modal', callback, { once: true });
        }

        modal.show();
    }

    showError(message) {
        document.getElementById('errorMessage').textContent = message;
        const modal = new bootstrap.Modal(document.getElementById('errorModal'));
        modal.show();
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// ═══════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════

function initializeBackupManager() {
    console.log('[BACKUP] Initializing BackupManager...');

    const requiredElements = [
        'getEstimateBtn', 'createBackupBtn', 'selectBackupBtn',
        'restoreBackupBtn', 'fileDropZone'
    ];

    const missing = requiredElements.filter(id => !document.getElementById(id));
    if (missing.length > 0) {
        console.warn('[BACKUP] Missing elements, retrying:', missing);
        setTimeout(initializeBackupManager, 100);
        return;
    }

    if (!window.backupManager) {
        window.backupManager = new BackupManager();
        console.log('[BACKUP] BackupManager initialized successfully');
    }

    // Translate if i18n is ready
    if (window.I18n) window.I18n.translatePage();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeBackupManager);
} else {
    initializeBackupManager();
}

// Warn if leaving during operation
window.addEventListener('beforeunload', (e) => {
    if (window.backupManager && window.backupManager.isOperationInProgress) {
        e.preventDefault();
        e.returnValue = 'A backup or restore operation is in progress. Are you sure you want to leave?';
        return e.returnValue;
    }
});
