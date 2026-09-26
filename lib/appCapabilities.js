// Supported tools and platforms in the desktop application.
const platforms = ['facebook', 'pinterest'];

async function getAppCapabilities() {
  return {
    success: true,
    community_disabled: true,
    platforms: [...platforms],
    features: {
      telegram_notifications: true,
      fb_analytics: true,
      fb_insights_mode: true,
      ai_agent: true,
      fb_groups: true,
      allowed_nodes: Object.keys(require('../data/automationSchema.json').nodes),
    },
  };
}

module.exports = { getAppCapabilities };
