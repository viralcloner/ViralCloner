const TelegramBot = require('node-telegram-bot-api');
const { readKey } = require('./utils');

class TelegramNotificationManager {
    constructor() {
        this.bot = null;
        this.settings = null;
        this.isInitialized = false;
    }

    async loadSettings() {
        try {
            this.settings = await readKey('telegramSettings') || {
                botToken: '',
                chatId: '',
                enabled: false,
                notifications: {
                    captchaDetected: true,
                    workflowCompleted: true,
                    workflowFailed: true,
                    captchaCleared: true,
                    googleDisconnected: true,
                    googleReconnected: true
                }
            };
            console.log('[Telegram] Settings loaded:', JSON.stringify(this.settings, null, 2));
            return this.settings;
        } catch (error) {
            console.error('Failed to load Telegram settings:', error.message);
            return null;
        }
    }

    async initialize() {
        try {
            await this.loadSettings();
            
            if (!this.settings || !this.settings.botToken || !this.settings.enabled) {
                this.isInitialized = false;
                return false;
            }

            // Initialize bot without polling to avoid conflicts
            this.bot = new TelegramBot(this.settings.botToken, { polling: false });
            this.isInitialized = true;
            console.log('✓ Telegram bot initialized successfully');
            return true;
        } catch (error) {
            console.error('Failed to initialize Telegram bot:', error.message);
            this.isInitialized = false;
            return false;
        }
    }

    async validateBotToken(token) {
        try {
            const testBot = new TelegramBot(token, { polling: false });
            const botInfo = await testBot.getMe();
            return {
                success: true,
                botInfo: {
                    id: botInfo.id,
                    username: botInfo.username,
                    first_name: botInfo.first_name
                }
            };
        } catch (error) {
            console.error('Telegram bot validation failed:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async sendTestMessage(token, chatId) {
        try {
            const testBot = new TelegramBot(token, { polling: false });
            const message = `✅ *Test Notification*\n\nYour Telegram notifications are working correctly!\n\nTime: ${new Date().toLocaleString()}`;
            
            await testBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            return { success: true };
        } catch (error) {
            console.error('Failed to send test message:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async sendWelcomeMessage(token, chatId) {
        try {
            const welcomeBot = new TelegramBot(token, { polling: false });
            const message = `🎉 *Welcome to Viral Cloner Notifications!*\n\n` +
                `Your Telegram notifications have been successfully configured.\n\n` +
                `*You will receive notifications for:*\n` +
                `🔔 Workflow completions\n` +
                `⚠️ Workflow failures\n` +
                `🛡️ Captcha detections\n` +
                `✅ Captcha clearances\n\n` +
                `You can manage your notification preferences anytime in the Settings.\n\n` +
                `_Setup completed at ${new Date().toLocaleString()}_`;
            
            await welcomeBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            return { success: true };
        } catch (error) {
            console.error('Failed to send welcome message:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async sendNotification(type, data) {
        try {
            console.log(`[Telegram] Attempting to send notification: ${type}`, data);
            
            // Reload settings to get latest configuration
            await this.loadSettings();

            // Check if notifications are enabled
            if (!this.settings || !this.settings.enabled || !this.settings.chatId) {
                console.log(`[Telegram] Notifications disabled or not configured. Enabled: ${this.settings?.enabled}, ChatId: ${this.settings?.chatId}`);
                return { success: false, reason: 'notifications_disabled' };
            }

            // Map captchaFalsePositive to use captchaCleared setting (it's the same event category)
            const settingsKey = type === 'captchaFalsePositive' ? 'captchaCleared' : type;

            // Check if this specific notification type is enabled
            if (!this.settings.notifications[settingsKey]) {
                console.log(`[Telegram] Notification type '${type}' (settings key: ${settingsKey}) is disabled in settings`);
                return { success: false, reason: 'notification_type_disabled' };
            }

            // Initialize if not already done
            if (!this.isInitialized) {
                console.log(`[Telegram] Bot not initialized, initializing now...`);
                const initialized = await this.initialize();
                if (!initialized) {
                    console.log(`[Telegram] Initialization failed`);
                    return { success: false, reason: 'initialization_failed' };
                }
            }

            // Format message based on type
            const message = this.formatMessage(type, data);
            console.log(`[Telegram] Sending message:`, message);
            
            // Send message
            await this.bot.sendMessage(this.settings.chatId, message, { parse_mode: 'Markdown' });
            console.log(`✓ Telegram notification sent successfully: ${type}`);
            return { success: true };
        } catch (error) {
            console.error(`Failed to send Telegram notification (${type}):`, error.message);
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
                let captchaMessage = `🚨 *CAPTCHA DETECTED*\n\n` +
                    `Profile: \`${data.profileId}\`\n` +
                    `Seed: \`${data.seed || 'N/A'}\`\n` +
                    `Time: ${timestamp}\n\n`;
                
                captchaMessage += `⚠️ Or solve the captcha in the application.`;
                return captchaMessage;

            case 'captchaCleared':
                return `✅ *CAPTCHA CLEARED*\n\n` +
                    `Profile: \`${data.profileId}\`\n` +
                    `Queue: ${data.queueLength || 0} requests waiting\n` +
                    `Time: ${timestamp}`;

            case 'captchaFalsePositive':
                return `🙏 *Sorry for the false alarm!*\n\n` +
                    `The captcha detection was a mistake, likely due to a temporary connection issue.\n\n` +
                    `Profile: \`${data.profileId}\`\n` +
                    `Auto-resolved in: ${Math.round((data.timeSinceDetection || 0) / 1000)}s\n` +
                    `Time: ${timestamp}\n\n` +
                    `_Your workflow continues normally._`;

            case 'workflowCompleted':
                const durationText = data.duration 
                    ? `Duration: ${data.duration}s\n` 
                    : '';
                return `✅ *WORKFLOW COMPLETED*\n\n` +
                    `Workflow ID: \`${data.workflowId}\`\n` +
                    `Posts: ${data.successfulPosts || 0}/${data.totalPosts || 0} successful\n` +
                    durationText +
                    `Time: ${timestamp}`;

            case 'workflowFailed':
                return `❌ *WORKFLOW FAILED*\n\n` +
                    `Workflow ID: \`${data.workflowId}\`\n` +
                    `Error: ${data.error || 'Unknown error'}\n` +
                    `Time: ${timestamp}`;

            case 'googleDisconnected':
                return `🔴 *GOOGLE ACCOUNT DISCONNECTED*\n\n` +
                    `Profile: \`${data.profileId}\`\n` +
                    `Time: ${timestamp}\n\n` +
                    `⚠️ Please reconnect your Google account in the application to resume Google Sites workflows.`;

            case 'googleReconnected':
                return `✅ *GOOGLE ACCOUNT RECONNECTED*\n\n` +
                    `Profile: \`${data.profileId}\`\n` +
                    `Time: ${timestamp}\n\n` +
                    `_Your Google Sites workflow will resume automatically._`;

            default:
                return `📢 *Notification*\n\n` +
                    `Type: ${type}\n` +
                    `Data: ${JSON.stringify(data, null, 2)}\n` +
                    `Time: ${timestamp}`;
        }
    }

    async getChatIdInstructions() {
        return {
            steps: [
                "1. Start a chat with your bot by searching for its username in Telegram",
                "2. Send any message to your bot (e.g., /start)",
                "3. Visit this URL in your browser (replace YOUR_BOT_TOKEN):",
                "   https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates",
                "4. Look for 'chat' object and find the 'id' field",
                "5. Copy that number and paste it in the Chat ID field"
            ],
            exampleUrl: "https://api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/getUpdates"
        };
    }
}

// Export singleton instance
const telegramNotifications = new TelegramNotificationManager();

module.exports = telegramNotifications;
