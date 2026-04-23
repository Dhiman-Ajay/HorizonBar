// bar.js

const container = document.getElementById('tab-container');
const btnNewTab = document.getElementById('btn-new-tab');
const btnCompact = document.getElementById('btn-compact');
const btnDonate = document.getElementById('btn-donate');
const btnClose = document.getElementById('btn-close');

let isCompact = false;
let scrollSaveTimeout = null;
let renderTimeout = null;
let dockedWindowId = null;

window.onload = async () => {
    const state = await chrome.storage.local.get(['isCompact', 'lastScrollPosition', 'dockedWindowId']);
    if (state.isCompact) {
        isCompact = true;
        document.body.classList.add('compact-mode');
        btnCompact.classList.add('active');
    }
    dockedWindowId = state.dockedWindowId;

    await renderTabs();
};

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "REFRESH_TABS") {
        dockedWindowId = msg.dockedWindowId;
        scheduleRenderTabs();
    } else if (msg.action === "UPDATE_AUDIO") {
        updateAudioState(msg.tabId, msg.audible, msg.mutedInfo);
    }
});

function scheduleRenderTabs() {
    if (renderTimeout) clearTimeout(renderTimeout);
    renderTimeout = setTimeout(() => {
        renderTabs();
    }, 50);
}

function getFavicon(url) {
    if (!url) return chrome.runtime.getURL("_favicon/?pageUrl=" + encodeURIComponent("about:blank") + "&size=32");
    // Use the MV3 native favicon helper
    // This handles chrome://, file://, and normal urls securely
    return chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
}

function updateAudioState(tabId, audible, mutedInfo) {
    const card = container.querySelector(`.tab-card[data-id="${tabId}"]`);
    if (!card) return;

    const controls = card.querySelector('.tab-controls');
    let btnMute = controls.querySelector('.btn-mute');

    const shouldShow = audible || mutedInfo.muted;
    const isMuted = mutedInfo.muted;

    if (shouldShow) {
        if (!btnMute) {
            // Create if missing (insert at start of controls to be before close button)
            btnMute = document.createElement('button');
            btnMute.className = 'control-btn btn-mute';
            btnMute.addEventListener('click', (e) => {
                e.stopPropagation();
                chrome.tabs.update(tabId, { muted: !isMuted }); // Use current state from closure/DOM often updated
            });
            // Re-bind click is tricky with closure "isMuted". 
            // Better to read state from button or keep it simple. 
            // Actually, simply replacing the button is fine, or updating its props.
            controls.insertBefore(btnMute, controls.firstChild);
        }

        // Update State
        btnMute.innerHTML = isMuted ? '🔇' : '🔊';
        btnMute.title = isMuted ? "Unmute" : "Mute";
        if (isMuted) btnMute.classList.add('mute-active');
        else btnMute.classList.remove('mute-active');

        // IMPORTANT: Update click handler to use latest state?
        // The click handler above uses stale `isMuted`. 
        // Let's use a dynamic check in the handler or replace the element.
        // Replacing is safer for closure correctness.
        const newBtn = btnMute.cloneNode(true);
        newBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // We know the CURRENT state based on the icon we just set
            // If icon is mute (muted), we want to unmute.
            const currentlyMuted = newBtn.classList.contains('mute-active');
            chrome.tabs.update(tabId, { muted: !currentlyMuted });
        });
        btnMute.replaceWith(newBtn);

    } else {
        if (btnMute) btnMute.remove();
    }
}

async function renderTabs() {
    // 1. Idempotent Clear
    container.innerHTML = '';

    try {
        let targetWindow;
        if (dockedWindowId) {
            try {
                targetWindow = await chrome.windows.get(dockedWindowId, { populate: true });
            } catch (e) {
                dockedWindowId = null;
            }
        }
        if (!targetWindow) {
            const allWindows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
            targetWindow = allWindows.find(w => w.state !== 'minimized' && w.id !== chrome.windows.WINDOW_ID_NONE) || allWindows[0];
        }

        if (!targetWindow) {
            container.innerText = "No tabs found.";
            return;
        }

        const tabs = targetWindow.tabs;
        let activeElement = null;

        tabs.forEach(tab => {
            const card = document.createElement('div');
            card.className = 'tab-card';
            card.dataset.id = tab.id; // Store ID for partial updates
            card.title = tab.title; // Native tooltip
            if (tab.active) {
                card.classList.add('active');
                activeElement = card;
            }

            const favicon = document.createElement('img');
            favicon.className = 'tab-favicon';
            favicon.src = getFavicon(tab.url);
            // _favicon API returns a default icon if missing, so explicit onerror is rarely needed, 
            // but keeping a safety catch is fine.
            favicon.onerror = () => {
                favicon.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PGNpcmNsZSBjeD0iOCIgY3k9IjgiIHI9IjgiIGZpbGw9IiM2NjYiLz48L3N2Zz4=';
                favicon.onerror = null;
            };

            const title = document.createElement('span');
            title.className = 'tab-title';
            title.textContent = tab.title;

            // Controls
            const controls = document.createElement('div');
            controls.className = 'tab-controls';

            // Mute Button
            if (tab.audible || tab.mutedInfo.muted) {
                const btnMute = document.createElement('button');
                btnMute.className = 'control-btn btn-mute';
                btnMute.innerHTML = tab.mutedInfo.muted ? '🔇' : '🔊';
                btnMute.title = tab.mutedInfo.muted ? "Unmute" : "Mute";
                if (tab.mutedInfo.muted) btnMute.classList.add('mute-active');

                btnMute.addEventListener('click', (e) => {
                    e.stopPropagation();
                    chrome.tabs.update(tab.id, { muted: !tab.mutedInfo.muted });
                });
                controls.appendChild(btnMute);
            }

            // Close Button
            const btnTabClose = document.createElement('button');
            btnTabClose.className = 'control-btn';
            btnTabClose.innerHTML = '×';
            btnTabClose.title = "Close Tab";
            // Use mousedown to prevent drag issues or focus shifts from stealing the event
            btnTabClose.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault(); // Prevent focus shift
                chrome.tabs.remove(tab.id);
            });
            // Also add click just in case, but mousedown usually triggers first and is safer for UI buttons
            btnTabClose.addEventListener('click', (e) => { e.stopPropagation(); });

            controls.appendChild(btnTabClose);

            card.appendChild(favicon);
            card.appendChild(title);
            card.appendChild(controls);

            card.addEventListener('click', () => {
                chrome.tabs.update(tab.id, { active: true });
                chrome.windows.update(tab.windowId, { focused: true });
            });

            container.appendChild(card);
        });

        // 2. Active-First Logic (RequestAnimationFrame)
        if (activeElement) {
            requestAnimationFrame(() => {
                activeElement.scrollIntoView({ behavior: 'instant', inline: 'center' });
            });
        }

    } catch (e) {
        console.error(e);
    }
}


// --- Controls ---

btnNewTab.addEventListener('click', async () => {
    const targetWindowId = dockedWindowId || (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0]?.id;
    if (targetWindowId) {
        chrome.tabs.create({ windowId: targetWindowId });
        chrome.windows.update(targetWindowId, { focused: true });
    }
});

btnCompact.addEventListener('click', () => {
    isCompact = !isCompact;
    if (isCompact) {
        document.body.classList.add('compact-mode');
        btnCompact.classList.add('active');
    } else {
        document.body.classList.remove('compact-mode');
        btnCompact.classList.remove('active');
    }
    chrome.storage.local.set({ isCompact: isCompact });
});

btnDonate.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://ajaykumardhiman.com/' });
});

btnClose.addEventListener('click', () => {
    window.close();
});

window.addEventListener('wheel', (e) => {
    const delta = e.deltaY + e.deltaX;
    if (delta !== 0) {
        e.preventDefault();
        container.scrollLeft += delta * 2;
    }
}, { passive: false });
