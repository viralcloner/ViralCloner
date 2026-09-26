let ws;
let messageQueue = [];
let reconnectTimeout = null;
let pingIntervalId = null;

// Offscreen support
async function ensureOffscreen(url) {
  if (chrome.offscreen) {
    const has = await chrome.offscreen.hasDocument?.();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'Maintain persistent WebSocket connection for spy plugin'
      });
    }
    // Tell offscreen to connect
    chrome.runtime.sendMessage({ type: 'WS_SET_URL', url });
    return true;
  }
  return false;
}

function connectWebSocket() {
  const wsUrl = "ws://localhost:5683"; // updated by utils.js at build time
  ensureOffscreen(wsUrl).then((usedOffscreen) => {
    if (usedOffscreen) return; // offscreen will manage the WS

    // Fallback: service worker holds the WS
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    try {
        ws = new WebSocket(wsUrl);
    } catch (e) {
        console.warn('WS construct failed:', e?.message || e);
        scheduleReconnect();
        return;
    }

    ws.addEventListener("open", () => {
        console.log("WebSocket connected");
        if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }

        while (messageQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify(messageQueue.shift())); } catch {}
        }

        try { if (pingIntervalId) clearInterval(pingIntervalId); } catch {}
        pingIntervalId = setInterval(() => {
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            try { ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
        }, 25000);
    });

    ws.addEventListener("close", (evt) => {
        const { code, reason } = evt || {};
        console.log("WebSocket closed", { code, reason });
        try { if (pingIntervalId) clearInterval(pingIntervalId); } catch {}
        scheduleReconnect();
    });

    ws.addEventListener("error", (err) => {
        console.warn('WebSocket error', err);
        try { if (pingIntervalId) clearInterval(pingIntervalId); } catch {}
        try { ws.close(); } catch {}
    });
  });
}

function scheduleReconnect() {
  if (!reconnectTimeout) {
      reconnectTimeout = setTimeout(() => {
          reconnectTimeout = null;
          connectWebSocket();
      }, 3000);
  }
}

connectWebSocket();

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "POST_DATA") {
        const payload = msg.data;
        if (chrome.offscreen) {
          // Prefer offscreen route
          chrome.runtime.sendMessage({ type: 'WS_SEND', data: payload });
          return;
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify(payload)); } catch {
                messageQueue.push(payload);
            }
        } else {
            messageQueue.push(payload);
            if (!ws || ws.readyState === WebSocket.CLOSED) {
                connectWebSocket();
            }
        }
    }
});
