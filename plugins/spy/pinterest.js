(async () => {
    const processedPins = new Set();
    const activeFetches = new Set();
    const maxConcurrency = 20;

    function getCsrfTokenFromCookies() {
        return document.cookie
            .split("; ")
            .find(row => row.startsWith("csrftoken="))
            ?.split("=")[1] || "";
    }

    async function getPinData(pinId) {
        if (processedPins.has(pinId)) return;
        processedPins.add(pinId);

        const url = `https://www.pinterest.com/resource/PinResource/get/?source_url=%2Fpin%2F${pinId}%2F&data=${encodeURIComponent(JSON.stringify({
            options: {
                id: pinId,
                field_set_key: "auth_web_main_pin",
                add_fields: "",
                noCache: true,
                fetch_visual_search_objects: true,
                get_page_metadata: false
            },
            context: {}
        }))}&_=${Date.now()}`;

        const headers = {
            "accept": "application/json, text/javascript, */*; q=0.01",
            "x-requested-with": "XMLHttpRequest",
            "x-pinterest-source-url": `/pin/${pinId}/`,
            "x-pinterest-appstate": "active",
            "x-pinterest-pws-handler": `www/pin/${pinId}.js`,
            "x-csrftoken": getCsrfTokenFromCookies(),
        };

        try {
            const response = await fetch(url, {
                method: "GET",
                credentials: "include",
                headers
            });

            if (!response.ok) {
                console.warn(`Pinterest API error for pin ${pinId}: ${response.status}`);
                return;
            }

            const json = await response.json();
            const data = json["resource_response"]?.["data"];
            if (data && !data["is_video"] && !data["is_promoted"]) {
                let title = data["title"] || data["seo_alt_text"] || (data["description"] || "").slice(0, 15) + "...";
                const { share_count: shares, comment_count: comments, repin_count: repins, link, id, description, via_pinner } = data;

                const image = data["images"]["orig"]["url"];

                let page;
                if (via_pinner) {
                    page = {
                        id: pinner["id"],
                        name: pinner["full_name"],
                        username: pinner["username"],
                        image: pinner["image_medium_url"],
                        followers: pinner["follower_count"],
                        domain_url: pinner["domain_url"]
                    };
                }

                const type = "pinterest";
                const now = Math.floor(Date.now() / 1000);

                chrome.runtime.sendMessage({
                    type: "POST_DATA",
                    data: {
                        type, title, description, image, shares, comments,
                        repins, link, id, page, now
                    }
                });
            }
        } catch (err) {
            console.error(`Error fetching pin ${pinId}:`, err);
        }
    }

    function extractVisiblePinIds() {
        const pins = document.querySelectorAll('a[href*="/pin/"]');
        const ids = new Set();
        pins.forEach(el => {
            const match = el.href.match(/\/pin\/(\d+)/);
            if (match) {
                const pinId = match[1];
                if (!processedPins.has(pinId)) {
                    ids.add(pinId);
                }
            }
        });
        return Array.from(ids);
    }

    async function manageQueue() {
        while (true) {
            const pinsToProcess = extractVisiblePinIds();

            for (const pinId of pinsToProcess) {
                if (activeFetches.size >= maxConcurrency) {
                    await Promise.race(activeFetches);
                }

                const fetchPromise = getPinData(pinId).finally(() => {
                    activeFetches.delete(fetchPromise);
                });

                activeFetches.add(fetchPromise);
            }

            await new Promise(res => setTimeout(res, 500));
        }
    }

    async function autoScroll() {
        let scrolls = 0;
        while (scrolls < 1000) {
            window.scrollBy(0, window.innerHeight);
            await new Promise(res => setTimeout(res, 5000));
            scrolls++;
        }
    }

    manageQueue();
    autoScroll();
})();
