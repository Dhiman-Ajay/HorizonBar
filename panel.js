// panel.js

const tabTray = document.getElementById('tab-tray');

async function renderTabs() {
    // Clear existing tabs
    tabTray.innerHTML = '';

    try {
        // Get all tabs in the current window
        const tabs = await chrome.tabs.query({ currentWindow: true });

        let activeTabElement = null;

        tabs.forEach(tab => {
            const card = document.createElement('div');
            card.className = 'tab-card';
            if (tab.active) {
                card.classList.add('active');
                // Set activeTabElement reference for scrolling later
            }

            // Favicon
            const favicon = document.createElement('img');
            favicon.className = 'tab-favicon';
            // Use a default icon if favIconUrl is missing or fails (could add error handling)
            favicon.src = tab.favIconUrl || 'chrome://favicon/';

            // Title
            const title = document.createElement('span');
            title.className = 'tab-title';
            title.textContent = tab.title;

            card.appendChild(favicon);
            card.appendChild(title);

            // Click listeners

            // Left click: Switch to tab
            card.addEventListener('click', (e) => {
                if (e.button === 0) { // Left click
                    chrome.tabs.update(tab.id, { active: true });
                }
            });

            // Middle click: Close tab
            card.addEventListener('mouseup', (e) => {
                if (e.button === 1) { // Middle click
                    e.preventDefault(); // Prevent scrolling if applicable
                    chrome.tabs.remove(tab.id);
                }
            });

            tabTray.appendChild(card);

            if (tab.active) {
                activeTabElement = card;
            }
        });

        // Auto-scroll to active tab
        if (activeTabElement) {
            // Use scrollIntoView with smooth behavior after a short delay to ensure rendering
            setTimeout(() => {
                activeTabElement.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
            }, 100);
        }

    } catch (error) {
        console.error("Error rendering tabs:", error);
    }
}

// Initial render
document.addEventListener('DOMContentLoaded', renderTabs);

// Listen for messages from background.js to refresh
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'refresh_tabs') {
        renderTabs();
    }
});

// Also listen for local changes if we want faster updates (redundant but safe)
// Actually, since background sends messages, we rely on that. 
// But we can also add visibility change listener to re-render when panel is opened.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        renderTabs();
    }
});
