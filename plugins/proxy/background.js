const HOST = "";
const PORT = "";
const USERNAME = "";
const PASSWORD = "";
const TAB_URL = "";

// Apply proxy immediately when service worker starts
console.log("[Proxy Extension] Service worker starting...");
console.log("[Proxy Extension] Config - HOST:", HOST, "PORT:", PORT);

function applyProxy() {
  if (HOST === "NULL" || HOST === "") {
    console.log("[Proxy Extension] No proxy configured, using direct mode");
    chrome.proxy.settings.set(
      { value: { mode: "direct" }, scope: "regular" },
      () => {
        console.log("[Proxy Extension] Proxy set to direct mode");
      }
    );
  } else {
    const config = {
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          scheme: "http",
          host: HOST,
          port: parseInt(PORT, 10),
        },
        bypassList: ["localhost", "127.0.0.1"],
      },
    };

    chrome.proxy.settings.set({ value: config, scope: "regular" }, () => {
      console.log("[Proxy Extension] Proxy applied:", HOST + ":" + PORT);
    });
  }
}

// Apply proxy immediately on script load
applyProxy();

function handleProxy() {
  chrome.proxy.settings.get({ incognito: false }, (details) => {
    const currentMode = details.value.mode;
    console.log("[Proxy Extension] Current proxy mode:", currentMode);

    function openGoogleAndCloseOthers() {
      chrome.tabs.query({}, (tabs) => {
        const tabIdsToClose = tabs.map(t => t.id);
        chrome.tabs.create({ url: TAB_URL }, (newTab) => {
          const filteredTabIds = tabIdsToClose.filter(id => id !== newTab.id);
          if (filteredTabIds.length) {
            chrome.tabs.remove(filteredTabIds, () => {
              console.log("[Proxy Extension] Closed other tabs:", filteredTabIds);
            });
          }
          console.log("[Proxy Extension] Opened tab with id:", newTab.id);
        });
      });
    }

    if (HOST === "NULL" || HOST === "") {
      if (currentMode !== "direct") {
        chrome.proxy.settings.set(
          { value: { mode: "direct" }, scope: "regular" },
          () => {
            console.log("[Proxy Extension] Proxy set to direct mode");
            reloadAllTabs();
            chrome.runtime.sendMessage({ type: "proxy-applied" });
            openGoogleAndCloseOthers();
          }
        );
      } else {
        console.log("[Proxy Extension] Already in direct mode — skipping");
        chrome.runtime.sendMessage({ type: "proxy-applied" });
        openGoogleAndCloseOthers();
      }
    } else {
      const config = {
        mode: "fixed_servers",
        rules: {
          singleProxy: {
            scheme: "http",
            host: HOST,
            port: parseInt(PORT, 10),
          },
          bypassList: ["localhost", "127.0.0.1"],
        },
      };

      chrome.proxy.settings.set({ value: config, scope: "regular" }, () => {
        console.log("[Proxy Extension] Proxy set:", config);
        reloadAllTabs();
        chrome.runtime.sendMessage({ type: "proxy-applied" });
        openGoogleAndCloseOthers();
      });
    }
  });
}

function reloadAllTabs() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.url && tab.url.startsWith("http")) {
        chrome.tabs.reload(tab.id, {}, () => {
          console.log("[Proxy Extension] Reloaded tab:", tab.url);
        });
      }
    }
  });
}

chrome.runtime.onStartup.addListener(() => {
  console.log("[Proxy Extension] onStartup fired");
  handleProxy();
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Proxy Extension] onInstalled fired");
  handleProxy();
});

chrome.webRequest.onAuthRequired.addListener(
  function (details, callbackFn) {
    console.log("[Proxy Extension] Auth required for:", details.url);
    if (HOST === "NULL" || HOST === "") {
      console.log("[Proxy Extension] No proxy configured, canceling auth prompt");
      callbackFn({ cancel: true });
    } else {
      console.log("[Proxy Extension] Providing credentials for:", USERNAME);
      callbackFn({
        authCredentials: {
          username: USERNAME,
          password: PASSWORD,
        },
      });
    }
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);
