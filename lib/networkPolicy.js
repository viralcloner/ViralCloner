// Prevent old URLs in imported workflows, stored avatars, and redirects from
// contacting the retired service. No DNS lookup is needed to enforce this rule.
const RETIRED_DOMAIN = 'viralcloner.com';
function isRetiredHost(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  return host === RETIRED_DOMAIN || host.endsWith('.' + RETIRED_DOMAIN) || host === '208.122.214.51';
}
function assertAllowedUrl(value) {
  const url = new URL(value);
  if (isRetiredHost(url.hostname)) {
    const error = new Error('The retired hosted service is unavailable in this local edition.');
    error.code = 'ERR_RETIRED_SERVICE';
    throw error;
  }
  return url;
}
let installed = false;
function installNodePolicy() {
  if (installed) return;
  installed = true;
  // This also covers native fetch redirects to the former IP address, which
  // would otherwise skip DNS and the http/https request wrappers.
  const Socket = require('net').Socket;
  const connect = Socket.prototype.connect;
  Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = first && typeof first === 'object'
      ? first.host || first.hostname
      : typeof args[1] === 'string' ? args[1] : null;
    if (isRetiredHost(host)) assertAllowedUrl('https://' + RETIRED_DOMAIN);
    return connect.apply(this, args);
  };
  for (const name of ['http', 'https']) {
    const transport = require(name);
    for (const method of ['request', 'get']) {
      const original = transport[method];
      transport[method] = function (...args) {
        const first = args[0];
        if (typeof first === 'string' || first instanceof URL) assertAllowedUrl(first);
        const options = typeof first === 'object' && !(first instanceof URL) ? first : args[1];
        if (options && typeof options === 'object') {
          if (isRetiredHost(options.hostname || String(options.host || '').split(':')[0])) {
            assertAllowedUrl('https://' + RETIRED_DOMAIN);
          }
          if (/^https?:\/\//i.test(options.path || '')) assertAllowedUrl(options.path);
        }
        return original.apply(this, args);
      };
    }
  }
  const dns = require('dns');
  const lookup = dns.lookup;
  dns.lookup = function (hostname, ...args) {
    if (isRetiredHost(hostname)) {
      const callback = args[args.length - 1];
      const error = Object.assign(new Error('Retired service blocked'), { code: 'ENOTFOUND' });
      if (typeof callback === 'function') return process.nextTick(callback, error);
      throw error;
    }
    return lookup.call(this, hostname, ...args);
  };
  if (global.fetch) {
    const fetch = global.fetch;
    global.fetch = async (input, ...args) => {
      assertAllowedUrl(typeof input === 'string' || input instanceof URL ? input : input.url);
      return fetch(input, ...args);
    };
  }
}
function installSessionPolicy(session) {
  session.webRequest.onBeforeRequest((details, callback) => {
    let cancel = false;
    try { cancel = isRetiredHost(new URL(details.url).hostname); } catch (_) {}
    callback({ cancel });
  });
}
const browserHostRules = 'MAP viralcloner.com ~NOTFOUND, MAP *.viralcloner.com ~NOTFOUND, MAP 208.122.214.51 ~NOTFOUND';
const browserProxyBypass = 'viralcloner.com;*.viralcloner.com;208.122.214.51';
const browserBlockedUrls = ['*://viralcloner.com/*', '*://*.viralcloner.com/*', '*://208.122.214.51/*'];
module.exports = { isRetiredHost, assertAllowedUrl, installNodePolicy, installSessionPolicy, browserHostRules, browserProxyBypass, browserBlockedUrls };
