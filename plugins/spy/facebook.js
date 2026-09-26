(function fastHumanScroll() {
    const minBurst = 200;
    const maxBurst = 400;
    const minBurstDelay = 3000; // 3 seconds  
    const maxBurstDelay = 6000; // 6 seconds
    const minStep = 1;
    const maxStep = 10;

    function scrollBurst() {
        const totalScroll = Math.floor(Math.random() * (maxBurst - minBurst + 1)) + minBurst;
        let scrolled = 0;

        function step() {
            if (scrolled >= totalScroll) return;
            const stepAmount = Math.floor(Math.random() * (maxStep - minStep + 1)) + minStep;
            window.scrollBy(0, stepAmount);
            scrolled += stepAmount;
            setTimeout(step, 0.5); // 0.5ms between tiny steps
        }

        step();

        const nextDelay = Math.floor(Math.random() * (maxBurstDelay - minBurstDelay + 1)) + minBurstDelay;
        setTimeout(scrollBurst, nextDelay);
    }

    scrollBurst();
})();

setTimeout(() => {
    window.location.reload();
}, 4000);

var sent = [];

function extractPosts() {
    const posts = document.querySelectorAll("div[role='main'] [data-ad-rendering-role='profile_name']");
    for (let post of posts) {
        const logs = [];
        try {
            const postContainer = post.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement;
            if (!postContainer) {
                logs.push("postContainer not found");
                continue;
            }

            let pageUrl = post.querySelector("a[href][role='link']").getAttribute("href");
            if (pageUrl.slice(0, 4) !== "http") {
                pageUrl = "https://www.facebook.com" + pageUrl;
            }

            const pageElement = post.querySelector("a[href][role='link']");
            if (!pageElement) {
                logs.push("pageElement not found");
                continue;
            }
            const pageName = pageElement.textContent;

            const bigParent = post.parentElement.parentElement.parentElement.parentElement.previousElementSibling;
            if (!bigParent) {
                logs.push("bigParent not found");
                continue;
            }

            let pageImage = "";
            const imageElement = bigParent.getElementsByTagName("image")[0];
            if (imageElement) {
                pageImage = imageElement.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
            }

            const pat = post.parentElement.parentElement.nextElementSibling.children[0].querySelector("div a[attributionsrc] > span > span");
            if (!pat) {
                logs.push("pat not found");
                continue;
            }

            const allSpans = pat.querySelectorAll('span');
            const spans = Array.from(allSpans).filter(span => !span.querySelector('span'));
            let txt = "";
            const orderedSpans = [];

            spans.forEach(span => {
                if (getComputedStyle(span).position === "relative") {
                    orderedSpans.push({ span, order: parseInt(getComputedStyle(span).order) || 0 });
                }
            });

            orderedSpans.sort((a, b) => a.order - b.order);
            orderedSpans.forEach(item => { txt += item.span.textContent; });
            txt = txt.trim();

            const sponsoredWords = ["sponsored", "sponsorisé", "patrocinado"];
            if (sponsoredWords.some(word => txt.toLowerCase().includes(word.toLowerCase()))) {
                logs.push("Sponsored post skipped");
                continue;
            }

            let createdTime = parseTimestamp(txt);
            if (createdTime === 0) createdTime = Math.floor(Date.now() / 1000);

            const postMessageElement = postContainer.children[2].querySelector('div[data-ad-comet-preview="message"]');
            if (!postMessageElement) {
                logs.push("postMessageElement not found");
                continue;
            }

            postMessageElement.querySelectorAll("div[role='button']").forEach(elm => {
                elm.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
            });

            const postMessage = postMessageElement.textContent;

            const bigParent2 = postMessageElement.parentElement.parentElement.nextElementSibling;
            let postImg = "";
            if (bigParent2) {
                const postImgElement = bigParent2.querySelector('img[src^="https://scontent"]');
                if (postImgElement) postImg = postImgElement.src;
            }

            const links = post.parentElement.parentElement.parentElement.children[1].querySelectorAll("a[href][role='link']");
            const timeElement = links[links.length - 1];
            if (!timeElement) {
                logs.push("timeElement not found");
                continue;
            }

            if (!timeElement.hasAttribute("hovered")) {
                timeElement.dispatchEvent(new Event("pointerover", { bubbles: true, cancelable: true }));
                timeElement.setAttribute("hovered", "");
            } else {
                timeElement.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
                timeElement.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
            }

            const postUrl = timeElement.getAttribute("href");

            let reactions = 0, comments = 0, shares = 0;

            const toolbar = postContainer.children[3].querySelector("[role='toolbar']");
            if (toolbar) {
                const reactionSpans = toolbar.nextElementSibling.querySelectorAll("span");
                const lastSpan = reactionSpans[reactionSpans.length - 1];
                if (lastSpan) reactions = parseNumber(lastSpan.textContent);
            }

            const bottomButtons = postContainer.children[3].querySelectorAll("[role='button']");
            bottomButtons.forEach(elm => {
                const icon = elm.querySelector('i[data-visualcompletion="css-img"]');
                if (!icon) return;

                const bgPos = getComputedStyle(icon).backgroundPosition.trim();
                const spans = elm.parentElement.parentElement.children[0].querySelectorAll("span");
                const lastSpan = spans[spans.length - 1];
                if (!lastSpan) return;

                const count = parseNumber(lastSpan.textContent);
                if (isNaN(count)) return;

                if (bgPos === "0px -1218px") comments = count;
                else if (bgPos === "0px -1235px") shares = count;
            });

            if (comments === 0 && shares === 0) {
                bottomButtons.forEach(elm => {
                    if (!elm.querySelector('i[data-visualcompletion="css-img"]')) {
                        const text = elm.textContent.toLowerCase();
                        if (["commentaire", "commentaires", "comment", "comments", "comentario", "comentarios"].some(w => text.includes(w))) {
                            comments = parseNumber(text.replace(/commentaires?|comments?|comentarios?/g, '').trim());
                            if (isNaN(comments)) comments = 0;
                        } else if (["partage", "partages", "share", "shares", "compartir", "compartido"].some(w => text.includes(w))) {
                            shares = parseNumber(text.replace(/partages?|shares?|compartir|compartido/g, '').trim());
                            if (isNaN(shares)) shares = 0;
                        }
                    }
                });
            }

            if (postUrl && postUrl.startsWith("h") && !postUrl.includes("watch/") && !postContainer.querySelector('.vc-addtoqueue-button')) {
                const postId = getPostIdFromUrl(postUrl).postId;
                if (postId) {
                    console.log("Sending post ...");
                    if (!sent.includes(postId)) {
                        sent.push(postId);
                        const now = Math.floor(Date.now() / 1000);
                        const type = "facebook";
                        chrome.runtime.sendMessage({
                            type: "POST_DATA",
                            data: {
                                type, postId, pageUrl, pageName, pageImage,
                                createdTime, postMessage, postImg, postUrl,
                                reactions, shares, comments, now
                            }
                        });
                    }
                }
            }

        } catch (e) { }
    }
}

setInterval(extractPosts, 1000);

function utf8ToBase64(str) {
    const utf8Bytes = new TextEncoder().encode(str);
    const binaryStr = String.fromCharCode(...utf8Bytes);
    return btoa(binaryStr);
}

function base64ToUtf8(base64) {
    const binaryStr = atob(base64);
    const binaryLen = binaryStr.length;
    const bytes = new Uint8Array(binaryLen);
    for (let i = 0; i < binaryLen; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

function calculateScore(reactions, shares, createdTime) {
    const currentTime = parseInt(Date.now() / 1000);
    const timeDiff = (currentTime - createdTime) / (1000 * 3600 * 24);
    const reactionWeight = 0.4;
    const shareWeight = 0.4;
    const recencyWeight = 0.2;
    const maxReactions = 1000;
    const maxShares = 500;
    const normalizedReactions = Math.min(reactions / maxReactions, 1);
    const normalizedShares = Math.min(shares / maxShares, 1);
    const recencyScore = Math.max(1 - (timeDiff / 15), 0);
    const performanceScore = (normalizedReactions * reactionWeight) +
        (normalizedShares * shareWeight) +
        (recencyScore * recencyWeight);
    return performanceScore * 100;
}

function parseTimestamp(str) {
    const nowStr = ["instant", "now", "ahora"];
    const todayStr = ["today", "aujourd'hui", "hoy"];
    const yesterdayStr = ["yesterday", "hier", "ayer"];

    if (nowStr.some(word => str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(word))) {
        return parseInt(Date.now() / 1000);
    } else {
        const unitMap = {
            s: 1, sec: 1, seconde: 1, segundos: 1,
            m: 60, min: 60, minute: 60, minutos: 60,
            h: 3600, hr: 3600, heure: 3600, horas: 3600,
            d: 86400, jour: 86400, día: 86400,
            w: 604800, semaine: 604800, semana: 604800
        };
        const monthAliases = {
            "January": 0, "Janvier": 0, "Enero": 0,
            "February": 1, "Février": 1, "Febrero": 1,
            "March": 2, "Mars": 2, "Marzo": 2,
            "April": 3, "Avril": 3, "Abril": 3,
            "May": 4, "Mai": 4, "Mayo": 4,
            "June": 5, "Juin": 5, "Junio": 5,
            "July": 6, "Juillet": 6, "Julio": 6,
            "August": 7, "Août": 7, "Agosto": 7,
            "September": 8, "Septembre": 8, "Septiembre": 8,
            "October": 9, "Octobre": 9, "Octubre": 9,
            "November": 10, "Novembre": 10, "Noviembre": 10,
            "December": 11, "Décembre": 11, "Diciembre": 11
        };
        try {
            const cleanStr = str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            for (const word of todayStr) {
                if (cleanStr.includes(word)) {
                    const match = cleanStr.match(/(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
                    if (match) {
                        let hour = parseInt(match[1]);
                        const minute = parseInt(match[2]);
                        const ampm = match[3];
                        if (ampm) {
                            if (ampm.toLowerCase() === "pm" && hour < 12) hour += 12;
                            if (ampm.toLowerCase() === "am" && hour === 12) hour = 0;
                        }
                        const now = new Date();
                        return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute).getTime() / 1000);
                    }
                }
            }
            for (const word of yesterdayStr) {
                if (cleanStr.includes(word)) {
                    const match = cleanStr.match(/(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
                    if (match) {
                        let hour = parseInt(match[1]);
                        const minute = parseInt(match[2]);
                        const ampm = match[3];
                        if (ampm) {
                            if (ampm.toLowerCase() === "pm" && hour < 12) hour += 12;
                            if (ampm.toLowerCase() === "am" && hour === 12) hour = 0;
                        }
                        const now = new Date();
                        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, minute);
                        return Math.floor(yesterday.getTime() / 1000);
                    }
                }
            }
            const matchRelative = str.match(/^(\d+)\s*([a-zA-Zéèêçîïôûáíóúñ]+)$/i);
            if (matchRelative) {
                const value = parseInt(matchRelative[1]);
                const unit = matchRelative[2].toLowerCase();
                const multiplier = unitMap[unit];
                if (multiplier) {
                    return Math.floor(Date.now() / 1000) - value * multiplier;
                }
            }
            const matchAbsoluteTime = str.match(
                /^(\d{1,2})\s([A-Za-zéèêçîïôûáíóúñ]+)[,]?\s*(?:at|à)?\s*(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i
            );
            if (matchAbsoluteTime) {
                const day = parseInt(matchAbsoluteTime[1]);
                const monthName = matchAbsoluteTime[2];
                let hour = parseInt(matchAbsoluteTime[3]);
                const minute = parseInt(matchAbsoluteTime[4]);
                const ampm = matchAbsoluteTime[5];
                const month =
                    monthAliases[monthName.charAt(0).toUpperCase() + monthName.slice(1).toLowerCase()];
                if (month === undefined) return 0;
                if (ampm) {
                    if (ampm.toUpperCase() === "PM" && hour < 12) hour += 12;
                    if (ampm.toUpperCase() === "AM" && hour === 12) hour = 0;
                }
                const now = new Date();
                const year = now.getFullYear();
                return Math.floor(new Date(year, month, day, hour, minute).getTime() / 1000);
            }
            const matchSimpleDate = str.match(/^(\d{1,2})\s([A-Za-zéèêçîïôûáíóúñ]+)$/i);
            if (matchSimpleDate) {
                const day = parseInt(matchSimpleDate[1]);
                const monthName = matchSimpleDate[2];
                const month =
                    monthAliases[monthName.charAt(0).toUpperCase() + monthName.slice(1).toLowerCase()];
                if (month === undefined) return 0;
                const now = new Date();
                const year = now.getFullYear();
                return Math.floor(new Date(year, month, day).getTime() / 1000);
            }
        } catch (e) {
            return 0;
        }
        return 0;
    }
}

function parseNumber(str) {
    var res = 0;
    if (typeof str === "string") {
        const cleanedStr = str.replace(/[\s\u00A0]/g, '').toLowerCase().trim();
        if (cleanedStr.endsWith('k')) {
            res = parseFloat(fixDecimalSeparator(cleanedStr)) * 1000;
        } else if (cleanedStr.endsWith('m')) {
            res = parseFloat(fixDecimalSeparator(cleanedStr)) * 1000000;
        } else {
            res = parseFloat(fixDecimalSeparator(cleanedStr));
        }
    }
    return res;
}

function fixDecimalSeparator(str) {
    let numericPart = str.replace(/[^0-9,.\-]/g, '');
    numericPart = numericPart.replace(',', '.');
    return numericPart;
}

function getPostIdFromUrl(url) {
    const facebookPatterns = [
        /facebook\.com\/.*?\/posts\/([a-zA-Z0-9]+)/,
        /facebook\.com\/story\.php\?story_fbid=([0-9]+)&id=[0-9]+/,
        /facebook\.com\/photo\.php\?fbid=([0-9]+)/,
        /facebook\.com\/permalink\.php\?story_fbid=([0-9]+)&id=[0-9]+/,
        /facebook\.com\/.*\/videos\/([0-9]+)/,
        /facebook\.com\/.*\/photos\/.*?\/([0-9]+)/
    ];

    const pinterestPatterns = [
        /pinterest\.com\/pin\/(\d+)/
    ];

    for (const pattern of facebookPatterns) {
        const match = url.match(pattern);
        if (match) return { platform: 'facebook', postId: match[1] };
    }

    for (const pattern of pinterestPatterns) {
        const match = url.match(pattern);
        if (match) return { platform: 'pinterest', postId: match[1] };
    }

    return { platform: 'unknown', postId: null };
}