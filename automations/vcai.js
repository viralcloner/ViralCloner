// Saved VCAI nodes fail locally with migration guidance, without transmitting prompts.
const message = 'Hosted ViralCloner AI is unavailable. Select a provider in Settings and use its AI node.';
module.exports = {
  vcai: async () => ({ success: false, value: message }),
  vcaiChat: async () => ({ success: false, value: message }),
  makeVCAIRequest: async () => { throw new Error(message); },
  getVCAIUsage: async () => ({ success: true, disabled: true }),
  checkVCAIHealth: async () => ({ success: false, disabled: true, error: message }),
};
