const { app } = require('electron');
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const { readKey } = require('./utils');

// Import database - lazy load to avoid circular dependency issues
let workflowDb = null;
function getWorkflowDb() {
    if (!workflowDb) {
        try {
            workflowDb = require('./database');
        } catch (error) {
            console.error('Failed to load database module:', error.message);
        }
    }
    return workflowDb;
}

class CleanupManager {
    constructor() {
        // Handle case where app might not be available (for testing)
        this.userDataPath = (app && app.getPath) ? app.getPath('userData') :
                           (global.app && global.app.getPath) ? global.app.getPath('userData') :
                           'C:\\Users\\admin\\AppData\\Roaming\\viralcloner';
        this.profilesPath = path.join(this.userDataPath, 'profiles');
        this.imagesPath = path.join(this.userDataPath, 'Images');
        this.audioPath = path.join(this.userDataPath, 'Audio');
        this.videosPath = path.join(this.userDataPath, 'Videos');
        this.tempUploadsPath = path.join(this.userDataPath, 'Uploads', 'Temp');
        this.cleanupLog = [];
        this.dryRun = false;

        // Media file extensions handled by the unified directory sweep.
        this.imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tif', '.tiff'];
        this.videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'];
        this.audioExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma', '.opus'];

        // Configuration for temp file cleanup
        // Default: 7 days retention for workflow images (was 24h causing issues)
        this.tempFileMaxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
        this.tempFileProtectionTime = 30 * 60 * 1000; // 30 minutes protection for new files
        // When any workflow is actively running, intermediate media (e.g. TTS audio
        // that is generated then consumed by a later node) may exist on disk without
        // being referenced by any persisted DB field. Protect recently-modified media
        // for this long while workflows are active to avoid deleting in-flight files.
        this.activeWorkflowProtectionTime = 24 * 60 * 60 * 1000; // 24 hours
        this.maxTempFolderSize = 1 * 1024 * 1024 * 1024; // 1GB threshold
        this.emergencyCleanupSize = 5 * 1024 * 1024 * 1024; // 5GB emergency threshold
        
        // Workflow age protection: protect images from workflows created within this period
        this.workflowProtectionDays = 7; // Days to protect workflow images

        // Protected folders (never cleaned up):
        // - AutomationScreenshots: Automation flow diagram screenshots
        // - AutomationThumbnails: Generated thumbnails from workflow outputs
        
        // Load user-configured retention if available
        this._loadRetentionSettings();
    }
    
    async _loadRetentionSettings() {
        try {
            const retentionDays = await readKey('tempFileRetentionDays');
            if (retentionDays && typeof retentionDays === 'number' && retentionDays > 0) {
                this.tempFileMaxAge = retentionDays * 24 * 60 * 60 * 1000;
                this.workflowProtectionDays = retentionDays;
                this.log(`Loaded custom retention period: ${retentionDays} days`);
            }
        } catch (error) {
            // Use defaults if setting not found
        }
    }

    log(message, type = 'info') {
        const timestamp = new Date().toISOString();
        const logEntry = { timestamp, type, message };
        this.cleanupLog.push(logEntry);
        console.log(`[CLEANUP ${type.toUpperCase()}] ${message}`);
    }

    async getActiveProfiles() {
        const activeProfiles = new Set();

        try {
            // Get Google profiles
            const googleProfiles = await readKey('googleProfiles') || {};
            Object.keys(googleProfiles).forEach(profileId => activeProfiles.add(profileId));
            this.log(`Found ${Object.keys(googleProfiles).length} Google profiles`);

            // Get OpenAI profiles (for ChatGPT Image)
            const openaiProfiles = await readKey('openaiProfiles') || {};
            Object.keys(openaiProfiles).forEach(profileId => activeProfiles.add(profileId));
            this.log(`Found ${Object.keys(openaiProfiles).length} OpenAI profiles`);

            // Get Discord profiles (for Midjourney)
            const discordProfiles = await readKey('discordProfiles') || {};
            Object.keys(discordProfiles).forEach(profileId => activeProfiles.add(profileId));
            this.log(`Found ${Object.keys(discordProfiles).length} Discord profiles`);

            // Get spy profiles
            const spyProfiles = await readKey('spyProfiles') || {};
            Object.keys(spyProfiles).forEach(profileId => activeProfiles.add(profileId));
            this.log(`Found ${Object.keys(spyProfiles).length} spy profiles`);

            // Get Meta AI profiles
            const metaaiProfiles = await readKey('metaaiProfiles') || {};
            Object.keys(metaaiProfiles).forEach(profileId => activeProfiles.add(profileId));
            this.log(`Found ${Object.keys(metaaiProfiles).length} Meta AI profiles`);

            // Get DeepSeek Browser profiles
            const deepseekBrowserProfiles = await readKey('deepseekBrowserProfiles') || {};
            Object.keys(deepseekBrowserProfiles).forEach(profileId => activeProfiles.add(profileId));
            this.log(`Found ${Object.keys(deepseekBrowserProfiles).length} DeepSeek Browser profiles`);

            // Get Qwen Browser profiles
            const qwenBrowserProfiles = await readKey('qwenBrowserProfiles') || {};
            Object.keys(qwenBrowserProfiles).forEach(profileId => activeProfiles.add(profileId));
            this.log(`Found ${Object.keys(qwenBrowserProfiles).length} Qwen Browser profiles`);

            // Get TikTok Ads profiles
            const tiktokAdsProfiles = await readKey('tiktokAdsProfiles') || {};
            Object.keys(tiktokAdsProfiles).forEach(profileId => activeProfiles.add(profileId));
            this.log(`Found ${Object.keys(tiktokAdsProfiles).length} TikTok Ads profiles`);

            // Get structure profiles
            const structures = await readKey('structures') || {};
            Object.values(structures).forEach(structure => {
                if (structure.profiles) {
                    Object.keys(structure.profiles).forEach(profileId => activeProfiles.add(profileId));
                }
            });

            const structureProfileCount = Object.values(structures).reduce((count, structure) => {
                return count + (structure.profiles ? Object.keys(structure.profiles).length : 0);
            }, 0);
            this.log(`Found ${structureProfileCount} structure profiles`);

        } catch (error) {
            this.log(`Error reading active profiles: ${error.message}`, 'error');
        }

        this.log(`Total active profiles: ${activeProfiles.size}`);
        return activeProfiles;
    }

    async getProfileFolders() {
        try {
            if (!fss.existsSync(this.profilesPath)) {
                this.log('Profiles directory does not exist');
                return [];
            }

            const folders = await fs.readdir(this.profilesPath);
            const profileFolders = [];

            for (const folder of folders) {
                const folderPath = path.join(this.profilesPath, folder);
                try {
                    const stat = await fs.stat(folderPath);
                    if (stat.isDirectory()) {
                        profileFolders.push(folder);
                    }
                } catch (error) {
                    this.log(`Error checking folder ${folder}: ${error.message}`, 'warn');
                }
            }

            this.log(`Found ${profileFolders.length} profile folders`);
            return profileFolders;
        } catch (error) {
            this.log(`Error reading profile folders: ${error.message}`, 'error');
            return [];
        }
    }

    async getOrphanedProfiles() {
        const activeProfiles = await this.getActiveProfiles();
        const profileFolders = await this.getProfileFolders();

        const orphanedProfiles = profileFolders.filter(folder => !activeProfiles.has(folder));
        this.log(`Found ${orphanedProfiles.length} orphaned profile folders`);

        return orphanedProfiles;
    }

    async getReferencedImages() {
        const referencedImages = new Set();

        try {
            // Check FB Groups Posts Library + automation posts (SQLite posts_library table).
            // These images live in userData/Images/ (when added via URL or CSV) so they MUST
            // be protected here, otherwise the orphan sweep deletes them.
            try {
                const fbGroupsDb = require('./facebookGroupsDatabase');
                const libPosts = fbGroupsDb.getLibraryPosts ? fbGroupsDb.getLibraryPosts() : [];
                libPosts.forEach(p => this._addLocalPath(referencedImages, p.imagePath || p.image_path));
                this.log(`Found ${libPosts.length} FB Groups library posts with potential image references`);
                // Also protect images attached to logged automation posts (post history)
                if (fbGroupsDb.getAllAutomationPostImages) {
                    const apImages = fbGroupsDb.getAllAutomationPostImages();
                    apImages.forEach(img => this._addLocalPath(referencedImages, img));
                    this.log(`Found ${apImages.length} FB Groups automation post images`);
                }
            } catch (fbErr) {
                this.log(`Could not read FB Groups library images: ${fbErr.message}`, 'warn');
            }

            // Check posts library
            const postsLibrary = await readKey('postsLibrary') || [];
            postsLibrary.forEach(post => {
                this._addLocalPath(referencedImages, post.postImg);
                if (post.page) {
                    this._addLocalPath(referencedImages, post.page.image);
                }
            });
            this.log(`Found ${postsLibrary.length} posts in library with potential image references`);

            // Check spy posts (locally downloaded images not yet in library)
            const spyPosts = await readKey('spyPosts') || [];
            spyPosts.forEach(post => {
                this._addLocalPath(referencedImages, post.postImg);
                if (post.page) {
                    this._addLocalPath(referencedImages, post.page.image);
                }
            });
            this.log(`Found ${spyPosts.length} spy posts with potential image references`);

            // Check followed pages (downloaded profile images)
            const followedPages = await readKey('followedPages') || {};
            let followedPageImageCount = 0;
            Object.values(followedPages).forEach(page => {
                if (this._addLocalPath(referencedImages, page.image)) followedPageImageCount++;
            });
            this.log(`Found ${followedPageImageCount} followed page images`);

            // Check mask templates
            const maskTemplates = await readKey('maskTemplates') || [];
            maskTemplates.forEach(template => {
                this._addLocalPath(referencedImages, template.image);
            });

            // Check FB Analytics saved scans (protect images from cleanup)
            const fbScans = await readKey('fbAnalyticsScans') || {};
            let fbScanImageCount = 0;
            Object.values(fbScans).forEach(scan => {
                if (scan.images && Array.isArray(scan.images)) {
                    scan.images.forEach(img => {
                        if (img.filename) {
                            referencedImages.add(img.filename);
                            fbScanImageCount++;
                        }
                    });
                }
            });
            this.log(`Found ${Object.keys(fbScans).length} FB Analytics scans with ${fbScanImageCount} protected images`);

            // Check workflows from JSON storage (legacy)
            const workflows = await readKey('workflows') || {};
            Object.values(workflows).forEach(workflow => {
                this.extractWorkflowImages(workflow, referencedImages);
            });
            this.log(`Checked ${Object.keys(workflows).length} workflows from JSON storage`);

            // CRITICAL: Check workflows from SQLite database
            const db = getWorkflowDb();
            if (db) {
                try {
                    const dbWorkflows = db.getAllWorkflowsSummary() || [];
                    this.log(`Found ${dbWorkflows.length} workflows in database`);
                    
                    for (const workflow of dbWorkflows) {
                        try {
                            // Get full workflow with posts
                            const fullWorkflow = db.getWorkflowWithPosts(workflow.workflowId);
                            if (fullWorkflow) {
                                this.extractWorkflowImages(fullWorkflow, referencedImages);
                            }
                        } catch (err) {
                            this.log(`Error getting workflow ${workflow.workflowId}: ${err.message}`, 'warn');
                        }
                    }
                } catch (dbError) {
                    this.log(`Error reading workflows from database: ${dbError.message}`, 'error');
                }
            } else {
                this.log('Database not available - skipping database workflow check', 'warn');
            }

            // CRITICAL: Pull every media path referenced anywhere in the workflow DB
            // (post images, post_outputs JSON, and node_executions messages such as
            // generated TTS audio). This protects userData/Audio and userData/Videos
            // files that are referenced by node outputs but not by posts directly.
            if (db && typeof db.getAllReferencedMediaPaths === 'function') {
                try {
                    const dbMedia = db.getAllReferencedMediaPaths();
                    dbMedia.forEach(p => referencedImages.add(p));
                    this.log(`Found ${dbMedia.size} media references from workflow DB (posts/outputs/node executions)`);
                } catch (mediaErr) {
                    this.log(`Error reading DB media references: ${mediaErr.message}`, 'warn');
                }
            }

            // Check video projects and video templates for media references
            const videoProjects = await readKey('videoProjects') || [];
            const videoTemplates = await readKey('videoTemplates') || [];
            const allVideoData = [...videoProjects, ...videoTemplates];
            let videoMediaCount = 0;
            allVideoData.forEach(item => {
                const project = item.project || item;
                if (project.tracks && Array.isArray(project.tracks)) {
                    project.tracks.forEach(track => {
                        if (track.clips && Array.isArray(track.clips)) {
                            track.clips.forEach(clip => {
                                if (this._addLocalPath(referencedImages, clip.source)) videoMediaCount++;
                            });
                        }
                    });
                }
            });
            this.log(`Found ${videoMediaCount} media references from ${allVideoData.length} video projects/templates`);

        } catch (error) {
            this.log(`Error reading referenced images: ${error.message}`, 'error');
        }

        this.log(`Found ${referencedImages.size} total referenced media files`);
        return referencedImages;
    }

    /**
     * Helper: add a local file path + its basename to the referenced set.
     * Returns true if something was added, false otherwise.
     */
    _addLocalPath(referencedImages, filePath) {
        if (filePath && typeof filePath === 'string' && !filePath.startsWith('http') && !filePath.startsWith('data:')) {
            referencedImages.add(filePath);
            referencedImages.add(path.basename(filePath));
            return true;
        }
        return false;
    }

    // Helper method to extract images from a workflow object
    extractWorkflowImages(workflow, referencedImages) {
        // Check workflow input data
        if (workflow.data && workflow.data.inputs) {
            Object.values(workflow.data.inputs).forEach(input => {
                if (typeof input === 'string' && /\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|mov|avi|mkv|m4v|mp3|wav|ogg|m4a|aac|flac|wma|opus)/i.test(input)) {
                    referencedImages.add(input);
                    referencedImages.add(path.basename(input));
                }
            });
        }
        
        // Check workflow posts for images
        if (workflow.posts && Array.isArray(workflow.posts)) {
            workflow.posts.forEach(post => {
                // Check original post images (cropped/inpainted images)
                // Handle both camelCase (postImg) and snake_case (post_img) 
                this._addLocalPath(referencedImages, post.postImg || post.post_img);
                
                // CRITICAL: Check original unprocessed input images (before cropping/inpainting)
                this._addLocalPath(referencedImages, post.originalInputImage || post.original_input_image);
                
                // Check Facebook output (image + video)
                const fbOutput = post.facebookOutput || post.facebook_output;
                if (fbOutput) {
                    this._addLocalPath(referencedImages, fbOutput.image);
                    this._addLocalPath(referencedImages, fbOutput.video);
                }
                
                // Check Pinterest output (image + video)
                const pOutput = post.pinterestOutput || post.pinterest_output;
                if (pOutput) {
                    this._addLocalPath(referencedImages, pOutput.image);
                    this._addLocalPath(referencedImages, pOutput.videoUrl);
                }
                
                // Check node execution outputs (may contain direct file paths)
                if (post.nodes && Array.isArray(post.nodes)) {
                    post.nodes.forEach(node => {
                        if (node.message && typeof node.message === 'string') {
                            // Node messages may contain file paths as output values
                            // (images, videos, and audio such as generated TTS mp3s)
                            if (/\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|mov|avi|mkv|m4v|mp3|wav|ogg|m4a|aac|flac|wma|opus)/i.test(node.message)) {
                                this._addLocalPath(referencedImages, node.message);
                            }
                        }
                    });
                }
            });
        }
    }

    async getImageFiles() {
        try {
            if (!fss.existsSync(this.imagesPath)) {
                this.log('Images directory does not exist');
                return [];
            }

            const files = await fs.readdir(this.imagesPath);
            const mediaFiles = files.filter(file => {
                const ext = path.extname(file).toLowerCase();
                return [
                    // Image formats
                    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
                    // Video formats
                    '.mp4', '.webm', '.mov', '.avi', '.mkv'
                ].includes(ext);
            });

            this.log(`Found ${mediaFiles.length} media files (images + videos)`);
            return mediaFiles;
        } catch (error) {
            this.log(`Error reading media files: ${error.message}`, 'error');
            return [];
        }
    }

    /**
     * Returns true if any workflow is currently running/queued. While active, the
     * workflow may be producing intermediate media files (e.g. TTS audio) whose
     * paths are only held in memory until consumed by a later node and are never
     * written to a persisted DB field. We use this to widen the new-file protection
     * window so in-flight media is never deleted mid-run.
     */
    async hasActiveWorkflows() {
        try {
            const db = getWorkflowDb();
            if (db && typeof db.getAllWorkflowsSummary === 'function') {
                const summaries = db.getAllWorkflowsSummary() || [];
                const active = summaries.some(w => {
                    const status = (w.status || '').toLowerCase();
                    // Terminal states - not active
                    const terminal = status === 'completed' || status === 'failed' || status === 'stopped' || status === 'cancelled';
                    if (status && !terminal) return true;
                    // Any pending posts means work is still queued for this workflow
                    if ((w.pendingPosts || w.pending_posts || 0) > 0) return true;
                    return false;
                });
                if (active) return true;
            }
        } catch (err) {
            // If we cannot determine, assume active (safer: protects in-flight media)
            this.log(`Could not determine active workflows, assuming active: ${err.message}`, 'warn');
            return true;
        }
        return false;
    }

    /**
     * The protection window for newly-modified media files. Widened while any workflow
     * is active so intermediate in-flight files are never deleted; otherwise the
     * standard short window applies so true orphans are cleaned promptly.
     */
    async getMediaProtectionWindow() {
        const active = await this.hasActiveWorkflows();
        return active ? this.activeWorkflowProtectionTime : this.tempFileProtectionTime;
    }

    async getUnreferencedImages() {
        const referencedImages = await this.getReferencedImages();
        const imageFiles = await this.getImageFiles();

        // SAFETY: If database was unavailable, we may have incomplete references.
        // Only proceed if we confirmed the DB was reachable or there are truly no workflows.
        const db = getWorkflowDb();
        if (!db) {
            this.log('⚠️ Database unavailable - aborting image cleanup to prevent data loss', 'warn');
            return [];
        }
        
        try {
            const workflowCount = (db.getAllWorkflowsSummary() || []).length;
            // If there are workflows but zero referenced images, something went wrong reading them
            if (workflowCount > 0 && referencedImages.size === 0) {
                this.log(`⚠️ Found ${workflowCount} workflows but 0 referenced images - aborting cleanup as safety measure`, 'warn');
                return [];
            }
        } catch (err) {
            this.log(`⚠️ Could not verify workflow count - aborting image cleanup: ${err.message}`, 'warn');
            return [];
        }

        // Add safety whitelist for critical images
        const whitelist = new Set([
            'app-icon.png',
            'logo.png',
            'default-avatar.png'
        ]);

        // Patterns for processed images that should NEVER be deleted without explicit reference check
        const protectedPatterns = [
            /_cropped\./i,      // Cropped images: image_cropped.jpg
            /_inpainted\./i,    // Inpainted images: image_inpainted.jpg or image_cropped_inpainted.jpg
        ];
        
        // Patterns for output files that should be protected if their source workflow exists
        const outputPatterns = [
            /^output_/i,         // output_POSTID_filename - preserved workflow outputs
            /^video_output_/i,   // video_output_POSTID_filename - preserved video outputs
        ];

        const unreferencedImages = imageFiles.filter(file => {
            // Never delete whitelisted files
            if (whitelist.has(file)) {
                return false;
            }
            
            // Already referenced - protect it
            if (referencedImages.has(file)) {
                return false;
            }
            
            // Check if file matches protected patterns (cropped/inpainted)
            const isProtectedPattern = protectedPatterns.some(pattern => pattern.test(file));
            if (isProtectedPattern) {
                this.log(`⚠️ Processed image not found in references: ${file} - verifying...`, 'warn');
                // Double check by looking for the base name without suffix
                const baseName = file.replace(/_cropped|_inpainted/gi, '');
                if (referencedImages.has(baseName)) {
                    this.log(`✓ Base image ${baseName} is referenced, protecting ${file}`, 'info');
                    return false; // Protect it
                }
            }
            
            // Check output files - extract post ID and verify the post no longer exists
            const isOutputFile = outputPatterns.some(pattern => pattern.test(file));
            if (isOutputFile) {
                // Extract post ID from filename format: output_POSTID_original.ext or video_output_POSTID_original.ext
                const match = file.match(/^(?:video_)?output_([^_]+)_/i);
                if (match) {
                    const postId = match[1];
                    try {
                        // If the post still exists in DB, protect this output file
                        const postInfo = db.getPostExportInfo(postId);
                        if (postInfo) {
                            this.log(`✓ Output file ${file} belongs to existing post ${postId}, protecting`, 'debug');
                            return false;
                        }
                    } catch (e) {
                        // If we can't verify, err on the side of caution
                        this.log(`⚠️ Could not verify post ${postId} for output file ${file}, protecting`, 'warn');
                        return false;
                    }
                }
            }
            
            return true;
        });

        // SAFETY: protect recently-modified images. While a workflow is active the
        // window is widened to 24h so in-flight images (generated but not yet saved
        // to a post) are never deleted mid-run.
        const protectionWindow = await this.getMediaProtectionWindow();
        const now = Date.now();
        const aged = [];
        for (const file of unreferencedImages) {
            try {
                const stat = await fs.stat(path.join(this.imagesPath, file));
                const age = now - Math.max(stat.mtimeMs || 0, stat.birthtimeMs || 0);
                if (age < protectionWindow) {
                    this.log(`Protected recently-modified image (in-flight guard): ${file}`, 'debug');
                    continue;
                }
            } catch (_) {
                // If we cannot stat it, skip deletion to be safe
                continue;
            }
            aged.push(file);
        }

        this.log(`Found ${aged.length} unreferenced media files out of ${imageFiles.length} total (after age guard)`);
        return aged;
    }

    // === TEMP UPLOADS CLEANUP METHODS ===

    async getTempUploadsFiles() {
        try {
            if (!fss.existsSync(this.tempUploadsPath)) {
                this.log('Temp uploads directory does not exist');
                return [];
            }

            const allTempFiles = [];
            await this.scanTempDirectory(this.tempUploadsPath, allTempFiles);

            this.log(`Found ${allTempFiles.length} temp files`);
            return allTempFiles;
        } catch (error) {
            this.log(`Error reading temp uploads: ${error.message}`, 'error');
            return [];
        }
    }

    async scanTempDirectory(dirPath, fileList) {
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (entry.isDirectory()) {
                    // Recursively scan subdirectories
                    await this.scanTempDirectory(fullPath, fileList);
                } else {
                    // Add file with metadata
                    try {
                        const stat = await fs.stat(fullPath);
                        fileList.push({
                            path: fullPath,
                            name: entry.name,
                            size: stat.size,
                            createdAt: stat.birthtime,
                            modifiedAt: stat.mtime,
                            age: Date.now() - stat.birthtime.getTime(),
                            directory: path.dirname(fullPath)
                        });
                    } catch (error) {
                        this.log(`Error reading temp file ${fullPath}: ${error.message}`, 'warn');
                    }
                }
            }
        } catch (error) {
            this.log(`Error scanning temp directory ${dirPath}: ${error.message}`, 'error');
        }
    }

    async getOrphanedTempFiles() {
        const tempFiles = await this.getTempUploadsFiles();
        const now = Date.now();

        // Get active workflows that might be using temp files
        const activeWorkflows = await this.getActiveWorkflows();
        const protectedPaths = new Set();

        // Protect files from active workflows
        activeWorkflows.forEach(workflow => {
            if (workflow.tempPaths) {
                workflow.tempPaths.forEach(p => protectedPaths.add(p));
            }
        });

        // CRITICAL: Get all referenced images from workflows (both active and completed)
        // This prevents deleting temp files that are still referenced by workflow outputs
        const referencedImages = await this.getReferencedImages();
        this.log(`Checking ${referencedImages.size} referenced images against temp files`);
        
        // CRITICAL: Get recent workflow images that should be protected regardless of reference status
        // This covers race conditions where images are generated but DB not yet updated
        const recentWorkflowImages = await this.getRecentWorkflowImages();
        this.log(`Found ${recentWorkflowImages.size} images from recent workflows to protect`);

        const orphanedFiles = tempFiles.filter(file => {
            // Skip files that are too new (protection time)
            if (file.age < this.tempFileProtectionTime) {
                return false;
            }

            // Skip files that are protected by active workflows
            if (protectedPaths.has(file.path)) {
                return false;
            }

            // CRITICAL: Skip files that are referenced by any workflow (including completed ones)
            // Check full path, filename, and normalized paths for robust matching
            if (this.isFileReferenced(file, referencedImages)) {
                this.log(`Protected temp file referenced by workflow: ${file.name}`, 'debug');
                return false;
            }
            
            // CRITICAL: Skip files that belong to recent workflows (within protection period)
            if (this.isFileReferenced(file, recentWorkflowImages)) {
                this.log(`Protected temp file from recent workflow: ${file.name}`, 'debug');
                return false;
            }

            // Include files older than max age (only if not referenced)
            if (file.age > this.tempFileMaxAge) {
                return true;
            }

            // Include files matching safe-to-delete patterns
            return this.isSafeTempFilePattern(file);
        });

        this.log(`Found ${orphanedFiles.length} orphaned temp files (${tempFiles.length} total)`);
        return orphanedFiles;
    }
    
    /**
     * Check if a file is referenced using multiple matching strategies
     * Handles path format mismatches between stored references and actual files
     */
    isFileReferenced(file, referencedImages) {
        // Direct match on full path
        if (referencedImages.has(file.path)) return true;
        
        // Match on filename only
        if (referencedImages.has(file.name)) return true;
        
        // Normalize path separators and check
        const normalizedPath = file.path.replace(/\\/g, '/');
        if (referencedImages.has(normalizedPath)) return true;
        
        // Check if any referenced image ends with this filename
        for (const ref of referencedImages) {
            if (typeof ref === 'string') {
                const refBasename = path.basename(ref);
                if (refBasename === file.name) return true;
                
                // Also check if the file path ends with the reference (handles relative paths)
                if (file.path.endsWith(ref) || normalizedPath.endsWith(ref)) return true;
            }
        }
        
        return false;
    }
    
    /**
     * Get images from recent workflows that should be protected
     * This protects images from workflows created within the protection period
     */
    async getRecentWorkflowImages() {
        const recentImages = new Set();
        const protectionPeriod = this.workflowProtectionDays * 24 * 60 * 60 * 1000;
        const cutoffDate = new Date(Date.now() - protectionPeriod);
        
        try {
            const db = getWorkflowDb();
            if (db) {
                // Get workflows created within protection period
                const recentWorkflows = db.getAllWorkflowsSummary() || [];
                
                for (const workflow of recentWorkflows) {
                    try {
                        const createdAt = new Date(workflow.createdAt);
                        if (createdAt >= cutoffDate) {
                            // Get all posts for this workflow and extract images
                            const fullWorkflow = db.getWorkflowWithPosts(workflow.workflowId);
                            if (fullWorkflow) {
                                this.extractWorkflowImages(fullWorkflow, recentImages);
                            }
                        }
                    } catch (err) {
                        // Skip this workflow if error
                    }
                }
                
                this.log(`Found ${recentImages.size} images from workflows created in last ${this.workflowProtectionDays} days`);
            }
        } catch (error) {
            this.log(`Error getting recent workflow images: ${error.message}`, 'warn');
        }
        
        return recentImages;
    }

    async getActiveWorkflows() {
        // This would need to be implemented to check for currently running workflows
        // For now, return empty array - can be enhanced later
        try {
            const workflows = await readKey('workflows') || {};
            // Check for any workflows in 'running' state
            return Object.values(workflows).filter(w => w.status === 'running' || w.status === 'processing');
        } catch (error) {
            this.log(`Error checking active workflows: ${error.message}`, 'warn');
            return [];
        }
    }

    isSafeTempFilePattern(file) {
        const safePatternsOlderThan6Hours = [
            /\.tmp$/i,
            /temp_\d+/i,
            /midjourney_temp/i,
            /canvas_temp/i,
            /export_temp/i,
            /^temp/i,
            /temp$/i,
            /[a-zA-Z0-9]{10}$/  // Random string folders from exportFlowImages
        ];

        // For files older than 6 hours, apply more aggressive cleanup
        const sixHours = 6 * 60 * 60 * 1000;
        if (file.age > sixHours) {
            return safePatternsOlderThan6Hours.some(pattern =>
                pattern.test(file.name) || pattern.test(path.basename(file.directory))
            );
        }

        return false;
    }

    async calculateTempUploadsSize() {
        const tempFiles = await this.getTempUploadsFiles();
        let totalSize = 0;

        for (const file of tempFiles) {
            totalSize += file.size;
        }

        this.log(`Total temp uploads size: ${this.formatFileSize(totalSize)}`);
        return totalSize;
    }

    async cleanupTempUploads(dryRun = false) {
        this.log(`Starting temp uploads cleanup (${dryRun ? 'DRY RUN' : 'LIVE MODE'})`);

        const orphanedFiles = await this.getOrphanedTempFiles();
        const results = {
            removed: [],
            errors: [],
            totalSize: 0
        };

        for (const file of orphanedFiles) {
            try {
                if (!dryRun) {
                    // Check if it's a directory or file
                    const stat = await fs.stat(file.path);
                    if (stat.isDirectory()) {
                        // Remove empty directories
                        const dirContents = await fs.readdir(file.path);
                        if (dirContents.length === 0) {
                            await fs.rmdir(file.path);
                            this.log(`Removed empty temp directory: ${file.path}`);
                        }
                    } else {
                        await fs.unlink(file.path);
                        this.log(`Removed temp file: ${file.path} (${this.formatFileSize(file.size)})`);
                    }
                }

                results.removed.push(file.path);
                results.totalSize += file.size;

            } catch (error) {
                // The file/dir being already gone is not an error - another part of the
                // cleanup (or the app) removed it between scan and delete. Count it as
                // removed and move on without noisy error logs.
                if (error.code === 'ENOENT') {
                    results.removed.push(file.path);
                    continue;
                }
                this.log(`Error removing temp file ${file.path}: ${error.message}`, 'error');
                results.errors.push({ path: file.path, error: error.message });
            }
        }

        // Clean up empty directories
        if (!dryRun) {
            await this.cleanupEmptyTempDirectories();
        }

        this.log(`Temp cleanup completed: ${results.removed.length} files removed, ${this.formatFileSize(results.totalSize)} freed`);
        return results;
    }

    async cleanupEmptyTempDirectories() {
        try {
            if (!fss.existsSync(this.tempUploadsPath)) return;

            const entries = await fs.readdir(this.tempUploadsPath, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const dirPath = path.join(this.tempUploadsPath, entry.name);
                    await this.removeEmptyDirectory(dirPath);
                }
            }
        } catch (error) {
            this.log(`Error cleaning empty temp directories: ${error.message}`, 'warn');
        }
    }

    async removeEmptyDirectory(dirPath) {
        try {
            const entries = await fs.readdir(dirPath);

            if (entries.length === 0) {
                await fs.rmdir(dirPath);
                this.log(`Removed empty temp directory: ${dirPath}`);
                return true;
            }

            // Recursively check subdirectories
            let hasFiles = false;
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry);
                const stat = await fs.stat(fullPath);

                if (stat.isDirectory()) {
                    const removed = await this.removeEmptyDirectory(fullPath);
                    if (!removed) hasFiles = true;
                } else {
                    hasFiles = true;
                }
            }

            // If all subdirectories were removed and no files exist, remove this directory
            if (!hasFiles) {
                const updatedEntries = await fs.readdir(dirPath);
                if (updatedEntries.length === 0) {
                    await fs.rmdir(dirPath);
                    this.log(`Removed empty temp directory: ${dirPath}`);
                    return true;
                }
            }

            return false;
        } catch (error) {
            this.log(`Error checking directory ${dirPath}: ${error.message}`, 'warn');
            return false;
        }
    }

    async calculateProfileFolderSize(profileId) {
        const profilePath = path.join(this.profilesPath, profileId);
        try {
            const files = await this.getAllFiles(profilePath);
            let totalSize = 0;

            for (const file of files) {
                try {
                    const stat = await fs.stat(file);
                    totalSize += stat.size;
                } catch (error) {
                    // Ignore files that can't be read
                }
            }

            return totalSize;
        } catch (error) {
            return 0;
        }
    }

    async getAllFiles(dirPath) {
        const files = [];
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    files.push(...await this.getAllFiles(fullPath));
                } else {
                    files.push(fullPath);
                }
            }
        } catch (error) {
            // Directory might not exist or be accessible
        }
        return files;
    }

    async calculateImageSize(imageName) {
        const imagePath = path.join(this.imagesPath, imageName);
        try {
            const stat = await fs.stat(imagePath);
            return stat.size;
        } catch (error) {
            return 0;
        }
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
    }

    async cleanupProfiles(dryRun = false) {
        this.dryRun = dryRun;
        this.cleanupLog = [];

        this.log(`Starting profile cleanup (${dryRun ? 'DRY RUN' : 'LIVE MODE'})`);

        const orphanedProfiles = await this.getOrphanedProfiles();
        const cleanupResults = {
            removed: [],
            errors: [],
            totalSize: 0
        };

        for (const profileId of orphanedProfiles) {
            const profilePath = path.join(this.profilesPath, profileId);
            const folderSize = await this.calculateProfileFolderSize(profileId);

            try {
                if (!dryRun) {
                    await fs.rm(profilePath, { recursive: true, force: true });
                    this.log(`Removed profile folder: ${profileId} (${this.formatFileSize(folderSize)})`);
                } else {
                    this.log(`Would remove profile folder: ${profileId} (${this.formatFileSize(folderSize)})`);
                }

                cleanupResults.removed.push({
                    id: profileId,
                    path: profilePath,
                    size: folderSize
                });
                cleanupResults.totalSize += folderSize;

            } catch (error) {
                this.log(`Error removing profile ${profileId}: ${error.message}`, 'error');
                cleanupResults.errors.push({
                    id: profileId,
                    error: error.message
                });
            }
        }

        this.log(`Profile cleanup completed. Removed: ${cleanupResults.removed.length}, Errors: ${cleanupResults.errors.length}, Total size freed: ${this.formatFileSize(cleanupResults.totalSize)}`);

        return {
            ...cleanupResults,
            logs: this.cleanupLog
        };
    }

    /**
     * Clean browser cache folders from ALL profile directories (active and orphaned).
     * Targets: Cache, Code Cache, GPUCache, ShaderCache, etc. at both the profile root
     * and inside the Default/ sub-profile directory where Chrome actually stores caches.
     * Session/login data (Cookies, Local Storage, etc.) is preserved.
     */
    async cleanActiveProfileCaches() {
        this.cleanupLog = [];
        this.log('Starting active profile cache cleanup');

        // These folders are safe to delete in both profile root AND Default/ subfolder
        const cacheDirs = [
            'Cache',
            'Cache_Data',
            'Code Cache',
            'GPUCache',
            'ShaderCache',
            'GrShaderCache',
            'GraphiteDawnCache',
            'DawnGraphiteCache',
            'DawnWebGPUCache',
            'component_crx_cache',
            'extensions_crx_cache',
            'optimization_guide_model_store',
            'BrowserMetrics',
            'Download Service/Files',
        ];

        const results = {
            profilesCleaned: 0,
            freedBytes: 0,
            errors: [],
        };

        let profileFolders = [];
        try {
            if (!fss.existsSync(this.profilesPath)) {
                this.log('Profiles directory does not exist');
                return { success: true, ...results };
            }
            const entries = await fs.readdir(this.profilesPath);
            for (const entry of entries) {
                const stat = await fs.stat(path.join(this.profilesPath, entry)).catch(() => null);
                if (stat && stat.isDirectory()) profileFolders.push(entry);
            }
        } catch (err) {
            this.log(`Error reading profiles directory: ${err.message}`, 'error');
            return { success: false, error: err.message };
        }

        this.log(`Found ${profileFolders.length} profile folders to clean`);

        for (const profileId of profileFolders) {
            const profileRoot = path.join(this.profilesPath, profileId);
            // Locations to scan: root and Default/ sub-folder
            const locations = [profileRoot, path.join(profileRoot, 'Default')];
            let profileFreed = 0;

            for (const loc of locations) {
                if (!fss.existsSync(loc)) continue;

                for (const cacheDir of cacheDirs) {
                    const target = path.join(loc, cacheDir);
                    if (!fss.existsSync(target)) continue;

                    try {
                        const size = await this._dirSize(target);
                        await fs.rm(target, { recursive: true, force: true });
                        profileFreed += size;
                        this.log(`Removed ${profileId}/${path.relative(profileRoot, target)} (${this.formatFileSize(size)})`);
                    } catch (err) {
                        this.log(`Error removing ${target}: ${err.message}`, 'error');
                        results.errors.push({ path: target, error: err.message });
                    }
                }
            }

            if (profileFreed > 0) {
                results.profilesCleaned++;
                results.freedBytes += profileFreed;
            }
        }

        this.log(`Cache cleanup done. Cleaned ${results.profilesCleaned} profiles, freed ${this.formatFileSize(results.freedBytes)}`);
        return {
            success: true,
            ...results,
            freedFormatted: this.formatFileSize(results.freedBytes),
            logs: this.cleanupLog,
        };
    }

    /** Recursively compute the size of a directory in bytes */
    async _dirSize(dirPath) {
        let total = 0;
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            await Promise.all(entries.map(async (entry) => {
                const full = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    total += await this._dirSize(full);
                } else {
                    const stat = await fs.stat(full).catch(() => null);
                    if (stat) total += stat.size;
                }
            }));
        } catch {
            // Ignore unreadable dirs
        }
        return total;
    }

    async cleanupImages(dryRun = false) {
        this.dryRun = dryRun;
        this.cleanupLog = [];

        this.log(`Starting image cleanup (${dryRun ? 'DRY RUN' : 'LIVE MODE'})`);

        const unreferencedImages = await this.getUnreferencedImages();
        const cleanupResults = {
            removed: [],
            errors: [],
            totalSize: 0
        };

        for (const imageName of unreferencedImages) {
            const imagePath = path.join(this.imagesPath, imageName);
            const imageSize = await this.calculateImageSize(imageName);

            try {
                if (!dryRun) {
                    await fs.unlink(imagePath);
                    this.log(`Removed image: ${imageName} (${this.formatFileSize(imageSize)})`);
                } else {
                    this.log(`Would remove image: ${imageName} (${this.formatFileSize(imageSize)})`);
                }

                cleanupResults.removed.push({
                    name: imageName,
                    path: imagePath,
                    size: imageSize
                });
                cleanupResults.totalSize += imageSize;

            } catch (error) {
                // Already gone (removed elsewhere between scan and delete) - not an error.
                if (error.code === 'ENOENT') {
                    cleanupResults.removed.push({ name: imageName, path: imagePath, size: imageSize });
                    continue;
                }
                this.log(`Error removing image ${imageName}: ${error.message}`, 'error');
                cleanupResults.errors.push({
                    name: imageName,
                    error: error.message
                });
            }
        }

        this.log(`Image cleanup completed. Removed: ${cleanupResults.removed.length}, Errors: ${cleanupResults.errors.length}, Total size freed: ${this.formatFileSize(cleanupResults.totalSize)}`);

        return {
            ...cleanupResults,
            logs: this.cleanupLog
        };
    }

    /**
     * Unified orphaned-media detector for a single directory (Audio, Videos, ...).
     * A file is considered orphaned only when it is NOT referenced anywhere, is not
     * brand new (protection window), and the workflow DB was readable (safety).
     */
    async getUnreferencedMediaInDir(dirPath, extensions) {
        if (!fss.existsSync(dirPath)) {
            this.log(`Directory does not exist: ${dirPath}`);
            return [];
        }

        // SAFETY: never sweep when DB is unavailable - references would be incomplete.
        const db = getWorkflowDb();
        if (!db) {
            this.log(`⚠️ Database unavailable - skipping cleanup of ${path.basename(dirPath)}`, 'warn');
            return [];
        }

        const referencedImages = await this.getReferencedImages();

        // SAFETY: workflows exist but no references resolved => something failed, abort.
        try {
            const workflowCount = (db.getAllWorkflowsSummary() || []).length;
            if (workflowCount > 0 && referencedImages.size === 0) {
                this.log(`⚠️ Found ${workflowCount} workflows but 0 referenced media - skipping ${path.basename(dirPath)} as safety measure`, 'warn');
                return [];
            }
        } catch (err) {
            this.log(`⚠️ Could not verify workflow count - skipping ${path.basename(dirPath)}: ${err.message}`, 'warn');
            return [];
        }

        const recentWorkflowImages = await this.getRecentWorkflowImages();

        // While workflows are active, widen the protection window so intermediate
        // in-flight media (e.g. TTS audio generated then consumed by a later node,
        // whose path is never persisted) is never deleted mid-run.
        const protectionWindow = await this.getMediaProtectionWindow();

        let entries;
        try {
            entries = await fs.readdir(dirPath);
        } catch (error) {
            this.log(`Error reading ${dirPath}: ${error.message}`, 'error');
            return [];
        }

        const orphaned = [];
        for (const name of entries) {
            const ext = path.extname(name).toLowerCase();
            if (!extensions.includes(ext)) continue;

            const fullPath = path.join(dirPath, name);
            let stat;
            try {
                stat = await fs.stat(fullPath);
            } catch (_) {
                continue;
            }
            if (!stat.isFile()) continue;

            const fileObj = { path: fullPath, name };

            // Referenced anywhere (active, completed, or recent workflows)? Protect it.
            if (this.isFileReferenced(fileObj, referencedImages)) continue;
            if (this.isFileReferenced(fileObj, recentWorkflowImages)) continue;

            // New-file / in-flight protection: don't delete media modified within the
            // protection window; it may belong to an in-progress workflow whose DB row
            // (or intermediate handoff) isn't persisted yet.
            const age = Date.now() - Math.max(stat.mtimeMs || 0, stat.birthtimeMs || 0);
            if (age < protectionWindow) continue;

            orphaned.push({ name, path: fullPath, size: stat.size });
        }

        this.log(`Found ${orphaned.length} unreferenced media files in ${path.basename(dirPath)}`);
        return orphaned;
    }

    /**
     * Delete orphaned media files from a single directory (used for Audio / Videos).
     */
    async cleanupMediaDirectory(dirPath, extensions, dryRun = false) {
        const label = path.basename(dirPath);
        this.log(`Starting ${label} cleanup (${dryRun ? 'DRY RUN' : 'LIVE MODE'})`);

        const orphaned = await this.getUnreferencedMediaInDir(dirPath, extensions);
        const results = { removed: [], errors: [], totalSize: 0 };

        for (const file of orphaned) {
            try {
                if (!dryRun) {
                    await fs.unlink(file.path);
                    this.log(`Removed ${label} file: ${file.name} (${this.formatFileSize(file.size)})`);
                } else {
                    this.log(`Would remove ${label} file: ${file.name} (${this.formatFileSize(file.size)})`);
                }
                results.removed.push({ name: file.name, path: file.path, size: file.size });
                results.totalSize += file.size;
            } catch (error) {
                // Already gone (removed elsewhere between scan and delete) - not an error.
                if (error.code === 'ENOENT') {
                    results.removed.push({ name: file.name, path: file.path, size: file.size });
                    continue;
                }
                this.log(`Error removing ${label} file ${file.name}: ${error.message}`, 'error');
                results.errors.push({ name: file.name, error: error.message });
            }
        }

        this.log(`${label} cleanup completed. Removed: ${results.removed.length}, Errors: ${results.errors.length}, Freed: ${this.formatFileSize(results.totalSize)}`);
        return { ...results, logs: this.cleanupLog };
    }

    async getCleanupStatus() {
        this.cleanupLog = [];

        this.log('Analyzing cleanup status...');

        const orphanedProfiles = await this.getOrphanedProfiles();
        const unreferencedImages = await this.getUnreferencedImages();
        const orphanedAudio = await this.getUnreferencedMediaInDir(this.audioPath, this.audioExtensions);
        const orphanedVideos = await this.getUnreferencedMediaInDir(this.videosPath, this.videoExtensions);
        const orphanedTempFiles = await this.getOrphanedTempFiles();

        // Calculate sizes
        let profilesSize = 0;
        for (const profileId of orphanedProfiles) {
            profilesSize += await this.calculateProfileFolderSize(profileId);
        }

        let imagesSize = 0;
        for (const imageName of unreferencedImages) {
            imagesSize += await this.calculateImageSize(imageName);
        }

        const audioSize = orphanedAudio.reduce((sum, f) => sum + f.size, 0);
        const videosSize = orphanedVideos.reduce((sum, f) => sum + f.size, 0);

        let tempFilesSize = 0;
        for (const tempFile of orphanedTempFiles) {
            tempFilesSize += tempFile.size;
        }

        const totalTempSize = await this.calculateTempUploadsSize();

        const status = {
            orphanedProfiles: {
                count: orphanedProfiles.length,
                size: profilesSize,
                formattedSize: this.formatFileSize(profilesSize),
                items: orphanedProfiles
            },
            unreferencedImages: {
                count: unreferencedImages.length,
                size: imagesSize,
                formattedSize: this.formatFileSize(imagesSize),
                items: unreferencedImages
            },
            unreferencedAudio: {
                count: orphanedAudio.length,
                size: audioSize,
                formattedSize: this.formatFileSize(audioSize),
                items: orphanedAudio.map(f => f.name)
            },
            unreferencedVideos: {
                count: orphanedVideos.length,
                size: videosSize,
                formattedSize: this.formatFileSize(videosSize),
                items: orphanedVideos.map(f => f.name)
            },
            tempUploads: {
                count: orphanedTempFiles.length,
                size: tempFilesSize,
                formattedSize: this.formatFileSize(tempFilesSize),
                items: orphanedTempFiles.map(f => f.path),
                totalSize: totalTempSize,
                totalFormattedSize: this.formatFileSize(totalTempSize),
                cleanableSize: tempFilesSize,
                cleanableFormattedSize: this.formatFileSize(tempFilesSize)
            },
            totalSize: profilesSize + imagesSize + audioSize + videosSize + tempFilesSize,
            totalFormattedSize: this.formatFileSize(profilesSize + imagesSize + audioSize + videosSize + tempFilesSize),
            logs: this.cleanupLog
        };

        this.log(`Cleanup status: ${status.orphanedProfiles.count} orphaned profiles (${status.orphanedProfiles.formattedSize}), ${status.unreferencedImages.count} unreferenced images (${status.unreferencedImages.formattedSize}), ${status.unreferencedAudio.count} audio (${status.unreferencedAudio.formattedSize}), ${status.unreferencedVideos.count} videos (${status.unreferencedVideos.formattedSize}), ${status.tempUploads.count} temp files (${status.tempUploads.formattedSize} cleanable of ${status.tempUploads.totalFormattedSize} total)`);

        return status;
    }

    async cleanupAll(dryRun = false) {
        this.log(`Starting full cleanup (${dryRun ? 'DRY RUN' : 'LIVE MODE'})`);

        const profileResults = await this.cleanupProfiles(dryRun);
        const imageResults = await this.cleanupImages(dryRun);
        const audioResults = await this.cleanupMediaDirectory(this.audioPath, this.audioExtensions, dryRun);
        const videoResults = await this.cleanupMediaDirectory(this.videosPath, this.videoExtensions, dryRun);
        const tempResults = await this.cleanupTempUploads(dryRun);

        const totalSize = profileResults.totalSize + imageResults.totalSize + audioResults.totalSize + videoResults.totalSize + tempResults.totalSize;
        const totalRemoved = profileResults.removed.length + imageResults.removed.length + audioResults.removed.length + videoResults.removed.length + tempResults.removed.length;
        const totalErrors = profileResults.errors.length + imageResults.errors.length + audioResults.errors.length + videoResults.errors.length + tempResults.errors.length;

        return {
            profiles: profileResults,
            images: imageResults,
            audio: audioResults,
            videos: videoResults,
            tempUploads: tempResults,
            totalSize: totalSize,
            totalFormattedSize: this.formatFileSize(totalSize),
            totalRemoved: totalRemoved,
            totalErrors: totalErrors
        };
    }
}

module.exports = { CleanupManager };