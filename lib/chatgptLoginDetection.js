const sessionCheckExpression = `(async () => {
  try {
    const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
    if (!response.ok) return false;
    const session = await response.json();
    return !!(session && session.user && session.user.id &&
      typeof session.accessToken === 'string' && session.accessToken.trim() &&
      (!session.expires || Date.parse(session.expires) > Date.now()));
  } catch (_) { return false; }
})()`;

function isChatGPTPage(tab) {
  try {
    const url = new URL(tab.url);
    return tab.type === 'page' && url.origin === 'https://chatgpt.com' &&
      !url.pathname.startsWith('/auth/') && !!tab.webSocketDebuggerUrl;
  } catch (_) { return false; }
}

// Only a boolean crosses CDP; session credentials remain inside the browser.
function verifyChatGPTSession(tab, WebSocket) {
  if (!isChatGPTPage(tab)) return Promise.resolve(false);
  return new Promise(resolve => {
    let socket;
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket) {
        try { socket.close(); } catch (_) {}
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 8000);
    try {
      socket = new WebSocket(tab.webSocketDebuggerUrl);
      socket.on('error', () => finish(false));
      socket.on('close', () => finish(false));
      socket.on('open', () => {
        try {
          socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
            expression: sessionCheckExpression, awaitPromise: true, returnByValue: true,
          } }));
        } catch (_) { finish(false); }
      });
      socket.on('message', data => {
        try {
          const response = JSON.parse(data.toString());
          if (response.id === 1) finish(!response.error && !response.result?.exceptionDetails && response.result?.result?.value === true);
        } catch (_) { finish(false); }
      });
    } catch (_) { finish(false); }
  });
}

module.exports = { isChatGPTPage, verifyChatGPTSession, sessionCheckExpression };
