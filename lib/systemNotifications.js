const { Notification, app } = require('electron');
const path = require('path');
const { readKey } = require('./utils');

class SystemNotificationManager {
    constructor() {
        this.settings = null;
        this.isInitialized = false;
        this.iconPath = path.join(__dirname, '..', 'frontend', 'assets', 'images', 'app-icon.ico');
    }

    async loadSettings() {
        try {
            this.settings = await readKey('systemNotificationSettings') || {
                enabled: true,
                playSound: true,
                notifications: {
                    captchaDetected: true,
                    workflowCompleted: true,
                    workflowFailed: true,
                    captchaCleared: true,
                    googleDisconnected: true,
                    googleReconnected: true
                }
            };
            console.log('[System Notifications] Settings loaded:', JSON.stringify(this.settings, null, 2));
            return this.settings;
        } catch (error) {
            console.error('Failed to load system notification settings:', error.message);
            return null;
        }
    }

    async initialize() {
        try {
            await this.loadSettings();
            
            if (!this.settings || !this.settings.enabled) {
                this.isInitialized = false;
                return false;
            }

            // Check if notifications are supported
            if (!Notification.isSupported()) {
                console.warn('[System Notifications] Notifications are not supported on this system');
                this.isInitialized = false;
                return false;
            }

            this.isInitialized = true;
            console.log('✓ System notifications initialized successfully');
            return true;
        } catch (error) {
            console.error('Failed to initialize system notifications:', error.message);
            this.isInitialized = false;
            return false;
        }
    }

    async sendTestNotification() {
        try {
            if (!Notification.isSupported()) {
                return {
                    success: false,
                    error: 'System notifications are not supported on this platform'
                };
            }

            const notification = new Notification({
                title: '✅ Test Notification',
                body: `Your system notifications are working correctly!\n\nTime: ${new Date().toLocaleString()}`,
                icon: this.iconPath,
                silent: false
            });

            notification.show();
            return { success: true };
        } catch (error) {
            console.error('Failed to send test notification:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async sendNotification(type, data) {
        try {
            console.log(`[System Notifications] Attempting to send notification: ${type}`, data);
            
            // Reload settings to get latest configuration
            await this.loadSettings();

            // Check if notifications are enabled
            if (!this.settings || !this.settings.enabled) {
                console.log(`[System Notifications] Notifications disabled. Enabled: ${this.settings?.enabled}`);
                return { success: false, reason: 'notifications_disabled' };
            }

            // Map captchaFalsePositive to use captchaCleared setting (it's the same event category)
            const settingsKey = type === 'captchaFalsePositive' ? 'captchaCleared' : type;

            // Check if this specific notification type is enabled
            if (!this.settings.notifications[settingsKey]) {
                console.log(`[System Notifications] Notification type '${type}' (settings key: ${settingsKey}) is disabled in settings`);
                return { success: false, reason: 'notification_type_disabled' };
            }

            // Check if notifications are supported
            if (!Notification.isSupported()) {
                console.log(`[System Notifications] Notifications not supported on this system`);
                return { success: false, reason: 'not_supported' };
            }

            // Format message based on type
            const { title, body } = this.formatMessage(type, data);
            console.log(`[System Notifications] Sending notification:`, { title, body });
            
            // Send notification
            const notification = new Notification({
                title,
                body,
                icon: this.iconPath,
                silent: !this.settings.playSound
            });

            notification.show();
            
            console.log(`✓ System notification sent successfully: ${type}`);
            return { success: true };
        } catch (error) {
            console.error(`Failed to send system notification (${type}):`, error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    formatMessage(type, data) {
        const timestamp = new Date().toLocaleString();

        switch (type) {
            case 'captchaDetected':
                return {
                    title: '🚨 CAPTCHA DETECTED',
                    body: `Profile: ${data.profileId}\nSeed: ${data.seed || 'N/A'}\nTime: ${timestamp}\n\nPlease solve the captcha in the application.`
                };

            case 'captchaCleared':
                return {
                    title: '✅ CAPTCHA CLEARED',
                    body: `Profile: ${data.profileId}\nQueue: ${data.queueLength || 0} requests waiting\nTime: ${timestamp}`
                };

            case 'captchaFalsePositive':
                return {
                    title: '🙏 Sorry - False Alarm!',
                    body: `The captcha detection was a mistake, likely due to a connection issue.\n\nProfile: ${data.profileId}\nAuto-resolved in: ${Math.round((data.timeSinceDetection || 0) / 1000)}s\n\nYour workflow continues normally.`
                };

            case 'workflowCompleted':
                const durationText = data.duration ? `\nDuration: ${data.duration}s` : '';
                return {
                    title: '✅ WORKFLOW COMPLETED',
                    body: `Workflow ID: ${data.workflowId}\nPosts: ${data.successfulPosts || 0}/${data.totalPosts || 0} successful${durationText}\nTime: ${timestamp}`
                };

            case 'workflowFailed':
                return {
                    title: '❌ WORKFLOW FAILED',
                    body: `Workflow ID: ${data.workflowId}\nError: ${data.error || 'Unknown error'}\nTime: ${timestamp}`
                };

            case 'googleDisconnected':
                return {
                    title: '🔴 GOOGLE ACCOUNT DISCONNECTED',
                    body: `Profile: ${data.profileId}\nTime: ${timestamp}\n\nPlease reconnect your Google account in the application.`
                };

            case 'googleReconnected':
                return {
                    title: '✅ GOOGLE ACCOUNT RECONNECTED',
                    body: `Profile: ${data.profileId}\nTime: ${timestamp}\n\nYour Google Sites workflow will resume automatically.`
                };

            default:
                return {
                    title: '📢 Notification',
                    body: `Type: ${type}\nTime: ${timestamp}`
                };
        }
    }

    isSupported() {
        return Notification.isSupported();
    }
}

// Export singleton instance
const systemNotifications = new SystemNotificationManager();

module.exports = systemNotifications;
