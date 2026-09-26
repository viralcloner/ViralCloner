// Offscreen document to hold a persistent WebSocket connection for MV3
let ws;
let queue = [];
let reconnectTimer = null;
let pingTimer = null;

function connect(url) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    scheduleReconnect(url);
    return;
  }

  ws.addEventListener('open', () => {
    // flush
    while (queue.length && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(queue.shift())); } catch {}
    }
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
      }
    }, 25000);
  });

  ws.addEventListener('close', (evt) => {
    try { if (pingTimer) clearInterval(pingTimer); } catch {}
    scheduleReconnect(url);
  });

  ws.addEventListener('error', () => {
    try { if (pingTimer) clearInterval(pingTimer); } catch {}
    try { ws.close(); } catch {}
  });
}

function scheduleReconnect(url) {
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect(url);
    }, 3000);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'WS_SEND') {
    const payload = msg.data;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(payload)); } catch { queue.push(payload); }
    } else {
      queue.push(payload);
    }
  }
  if (msg && msg.type === 'WS_SET_URL') {
    connect(msg.url);
  }
});
