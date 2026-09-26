const path = require('path');
const { app } = require('electron');

function getVCBrowserDirectory() {
  return path.join(app.getPath('userData'), 'vcbrowser');
}

function getVCBrowserPath() {
  return path.join(getVCBrowserDirectory(), 'VCBrowser.exe');
}

module.exports = { getVCBrowserDirectory, getVCBrowserPath };
