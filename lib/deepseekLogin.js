const ORIGIN = 'https://chat.deepseek.com';
const CURRENT_USER = `${ORIGIN}/api/v0/users/current`;

// A request's bearer token is only a candidate. Verify it in the browser before
// saving the login; the page may send expired credentials while showing sign-in.
function createDeepSeekLoginMonitor({ ws, onVerified, onObserved, onInvalidated, now = Date.now }) {
  let token = null;
  let generation = 0;
  let verifiedToken = null;
  let checking = false;
  let lastCheck = -Infinity;
  let nextId = 100;
  const commands = new Map();
  const requests = new Map();

  function send(method, params, metadata) {
    const id = nextId++;
    commands.set(id, { token, generation, ...metadata });
    ws.send(JSON.stringify({ id, method, params }));
  }

  function invalidate() {
    generation++;
    verifiedToken = null;
    checking = false;
    commands.clear();
    requests.clear();
    onInvalidated();
  }

  function refresh() {
    if (!token || verifiedToken === token || now() - lastCheck < 5000) return;
    if (checking && now() - lastCheck < 20000) return;
    // Drop any timed-out verification before starting another one.
    if (checking) invalidate();
    checking = true;
    lastCheck = now();
    send('Network.getCookies', { urls: [ORIGIN] }, { kind: 'cookies' });
  }

  function observe(status, body, headers) {
    onObserved(status, body, headers);
    const { isExpired } = require('./deepseekProfileState');
    if (isExpired(status, body)) invalidate();
  }

  async function handle(msg) {
    if (msg.method === 'Network.requestWillBeSent') {
      const request = msg.params?.request;
      if (!request?.url?.startsWith(`${ORIGIN}/api/v0/`)) return;
      const headers = request.headers || {};
      const auth = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
      if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return;
      if (token !== auth) {
        invalidate();
        token = auth;
        lastCheck = -Infinity;
      }
      if (request.url.split('?')[0] === CURRENT_USER) {
        requests.set(msg.params.requestId, { token, generation });
      }
      refresh();
      return;
    }

    if (msg.method === 'Network.responseReceived') {
      const request = requests.get(msg.params.requestId);
      if (!request || request.generation !== generation) return;
      request.status = msg.params.response.status;
      request.headers = msg.params.response.headers;
      // A 401 is authoritative even if Chrome cannot provide its response body.
      if (request.status === 401) observe(401, {}, request.headers);
      return;
    }
    if (msg.method === 'Network.loadingFailed') {
      requests.delete(msg.params.requestId);
      return;
    }
    if (msg.method === 'Network.loadingFinished') {
      const request = requests.get(msg.params.requestId);
      requests.delete(msg.params.requestId);
      if (request?.generation === generation && request.status !== undefined) {
        send('Network.getResponseBody', { requestId: msg.params.requestId }, { ...request, kind: 'body' });
      }
      return;
    }

    const command = commands.get(msg.id);
    if (!command) return;
    commands.delete(msg.id);
    if (command.generation !== generation || command.token !== token) return;
    if (msg.error) {
      if (command.kind !== 'body') checking = false;
      return;
    }
    if (command.kind === 'cookies') {
      if (!Array.isArray(msg.result?.cookies)) { checking = false; return; }
      // Explicit validation also covers /users/current having finished before
      // Network.enable, which previously left valid profiles stuck pending.
      send('Runtime.evaluate', {
        expression: `(async () => {
          if (location.origin !== ${JSON.stringify(ORIGIN)}) return null;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          try {
            const response = await fetch(${JSON.stringify(CURRENT_USER)}, {
              credentials: 'include', cache: 'no-store',
              headers: { authorization: ${JSON.stringify(command.token)} },
              signal: controller.signal
            });
            return { status: response.status, body: await response.json() };
          } catch (_) { return null; }
          finally { clearTimeout(timeout); }
        })()`,
        awaitPromise: true,
        returnByValue: true,
      }, { kind: 'validation', cookies: msg.result.cookies });
      return;
    }
    if (command.kind === 'body') {
      try {
        const body = msg.result.base64Encoded
          ? Buffer.from(msg.result.body, 'base64').toString('utf8') : msg.result.body;
        observe(command.status, JSON.parse(body), command.headers);
      } catch (_) {}
      return;
    }
    checking = false;
    const response = msg.result?.result?.value;
    if (!response) return;
    observe(response.status, response.body, {});
    if (command.generation !== generation) return;
    const user = response.body?.data?.biz_data;
    if (response.status !== 200 || response.body?.code !== 0 ||
        response.body?.data?.biz_code !== 0 || typeof user?.id !== 'string' || !user.id) return;
    verifiedToken = command.token;
    try {
      await onVerified(command.token, command.cookies, response.body);
    } catch (error) {
      invalidate();
      throw error;
    }
  }

  return {
    handle, refresh,
    isVerified: candidate => !!candidate && verifiedToken === candidate,
    close: () => { invalidate(); commands.clear(); requests.clear(); },
  };
}

module.exports = { createDeepSeekLoginMonitor };
