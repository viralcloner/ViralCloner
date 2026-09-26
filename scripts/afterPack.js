/**
 * electron-builder afterPack hook
 *
 * NOTE: Security fuses (RunAsNode off, asar integrity validation, OnlyLoadAppFromAsar,
 * cookie encryption, disabled inspect/NODE_OPTIONS) are configured natively via the
 * `build.electronFuses` option in package.json. electron-builder flips them right
 * before code signing AND injects the matching asar-integrity header, which manual
 * flipping here would NOT do (and would brick the app). Do not flip fuses in this hook.
 */
exports.default = async function afterPack(context) {};
