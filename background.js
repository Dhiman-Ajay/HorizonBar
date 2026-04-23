// background.js

let barWindowId = null;
let dockedWindowId = null;
let originalBounds = null; // { id, top, height, width, left, state }
let lastDockedState = null;
let isProcessingBoundsChange = false; // Prevent bounds-change race conditions
let isSyncingFocus = false; // Prevent infinite focus loops
let externalFocus = false; // Tracks focus outside Chrome windows
let barRestoreTimeoutId = null;
const BAR_RESTORE_DELAY_MS = 500; // Delay before restoring minimized bar
const BAR_HEIGHT = 80;

function getWindow(windowId, options) {
    return new Promise((resolve, reject) => {
        try {
            if (options !== undefined) {
                chrome.windows.get(windowId, options, (win) => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        resolve(win);
                    }
                });
            } else {
                chrome.windows.get(windowId, (win) => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        resolve(win);
                    }
                });
            }
        } catch (err) {
            reject(err);
        }
    });
}

function getLastFocusedWindow(options) {
    return new Promise((resolve, reject) => {
        try {
            chrome.windows.getLastFocused(options, (win) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(win);
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}

function getAllWindows(options) {
    return new Promise((resolve, reject) => {
        try {
            chrome.windows.getAll(options, (wins) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(wins);
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}

// --- Health Check Function ---
async function validateWindowStates() {
    if (!barWindowId || !dockedWindowId) return;
    
    try {
        const [dockedWindow, barWindow] = await Promise.all([
            getWindow(dockedWindowId, { populate: false }).catch(() => null),
            getWindow(barWindowId, { populate: false }).catch(() => null)
        ]);
        
        if (!dockedWindow || !barWindow) {
            // One of the windows no longer exists, clean up
            if (!dockedWindow) dockedWindowId = null;
            if (!barWindow) barWindowId = null;
            return;
        }
        
        // Fix any state inconsistencies
        if (dockedWindow.state === 'minimized' && barWindow.state !== 'minimized') {
            await chrome.windows.update(barWindowId, { state: 'minimized' });
        } else if (dockedWindow.state !== 'minimized' && barWindow.state === 'minimized') {
            scheduleRestoreMinimizedBar();
        }
        
        // Update last known state
        lastDockedState = dockedWindow.state;
    } catch (e) {
        console.error('Error in health check:', e);
    }
}

function scheduleRestoreMinimizedBar() {
    if (barRestoreTimeoutId) {
        clearTimeout(barRestoreTimeoutId);
    }

    barRestoreTimeoutId = setTimeout(async () => {
        barRestoreTimeoutId = null;

        if (!barWindowId) return;
        try {
            const [barWindow, dockedWindow] = await Promise.all([
                getWindow(barWindowId, { populate: false }).catch(() => null),
                dockedWindowId ? getWindow(dockedWindowId, { populate: false }).catch(() => null) : Promise.resolve(null)
            ]);

            if (!barWindow) {
                barWindowId = null;
                return;
            }

            if (barWindow.state !== 'minimized') return;
            if (!dockedWindow || dockedWindow.state === 'minimized') return;

            await chrome.windows.update(barWindowId, { state: 'normal' });
            await syncBarPosition();
        } catch (e) {
            console.error('Error restoring minimized bar:', e);
        }
    }, BAR_RESTORE_DELAY_MS);
}

// Run health check periodically
setInterval(validateWindowStates, 5000);

// --- Event Listeners for Sync ---
function notifyBar() {
    // Broadcast blindly to handle Service Worker restarts.
    // If the bar is closed, this will just fail silently (caught below).
    chrome.runtime.sendMessage({ action: "REFRESH_TABS", dockedWindowId: dockedWindowId }).catch(() => {
        // Bar might be closed or starting up
    });
}

chrome.tabs.onCreated.addListener(notifyBar);
chrome.tabs.onRemoved.addListener(notifyBar);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Specialized update for audio to prevent UI collapse
    if (changeInfo.audible !== undefined || changeInfo.mutedInfo) {
        chrome.runtime.sendMessage({
            action: "UPDATE_AUDIO",
            tabId: tabId,
            audible: tab.audible,
            mutedInfo: tab.mutedInfo
        }).catch(() => { });
        return; // Skip full refresh
    }

    // Full refresh for structural changes
    if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.favIconUrl) {
        notifyBar();
    }
});
chrome.tabs.onMoved.addListener(notifyBar);
chrome.tabs.onActivated.addListener(notifyBar);
chrome.tabs.onDetached.addListener(notifyBar);
chrome.tabs.onAttached.addListener(notifyBar);

chrome.windows.onCreated.addListener((createdWindow) => {
    if (createdWindow.type === 'normal' && barWindowId) {
        scheduleRestoreMinimizedBar();
    }
});

// --- Docking Logic ---

chrome.commands.onCommand.addListener((command) => {
    if (command === 'toggle-bar') {
        toggleBar();
    }
});

chrome.action.onClicked.addListener(() => {
    toggleBar();
});

chrome.runtime.onStartup.addListener(async () => {
    // Automatically open HorizonBar with browser startup
    try {
        // First try to recover existing windows
        await recoverExistingWindows();
        
        // If no existing windows found, create new bar
        if (barWindowId === null) {
            await createBar();
        }
    } catch (err) {
        console.error('Error auto-opening HorizonBar:', err);
    }
});

chrome.runtime.onInstalled.addListener(async () => {
    // Ensure extension is functional immediately after install/update
    try {
        // First try to recover existing windows
        await recoverExistingWindows();
        
        // If no existing windows found, create new bar
        if (barWindowId === null) {
            await createBar();
        }
    } catch (err) {
        console.error('Error opening HorizonBar after install:', err);
    }
});

// --- Recovery Function ---
async function recoverExistingWindows() {
    try {
        const allWindows = await getAllWindows({ populate: false });
        
        // Look for existing bar window (popup type, specific size)
        const potentialBarWindow = allWindows.find(w => 
            w.type === 'popup' && 
            w.height >= 70 && w.height <= 90 && // Around BAR_HEIGHT
            w.width > 100 // Reasonable width
        );
        
        if (potentialBarWindow) {
            barWindowId = potentialBarWindow.id;
            console.log('Recovered existing bar window:', barWindowId);
            
            // Find the docked window (likely the one below the bar)
            const dockedCandidates = allWindows.filter(w => 
                w.type === 'normal' && 
                w.id !== barWindowId &&
                Math.abs(w.top - (potentialBarWindow.top + BAR_HEIGHT)) < 50 // Within reasonable distance
            );
            
            if (dockedCandidates.length > 0) {
                // Pick the one with the closest position match
                dockedWindowId = dockedCandidates.reduce((best, current) => {
                    const bestDiff = Math.abs(best.top - (potentialBarWindow.top + BAR_HEIGHT));
                    const currentDiff = Math.abs(current.top - (potentialBarWindow.top + BAR_HEIGHT));
                    return currentDiff < bestDiff ? current : best;
                }).id;
                
                console.log('Recovered docked window:', dockedWindowId);
                chrome.storage.local.set({ dockedWindowId });
                
                // Get current state
                const dockedWindow = await getWindow(dockedWindowId, { populate: false });
                lastDockedState = dockedWindow.state;
                
                // Run health check to ensure states are consistent
                await validateWindowStates();
            }
        }
    } catch (e) {
        console.error('Error recovering windows:', e);
    }
}

async function toggleBar() {
    if (barWindowId !== null) {
        try {
            const win = await getWindow(barWindowId);
            if (win) {
                await closeBar();
                return;
            }
        } catch (e) {
            barWindowId = null;
        }
    }

    await createBar();
}

async function syncBarPosition() {
    if (!barWindowId || !dockedWindowId) return;
    try {
        const dockedWindow = await getWindow(dockedWindowId);
        const barWindow = await getWindow(barWindowId);
        
        // Don't sync if windows are minimized
        if (!dockedWindow || !barWindow || dockedWindow.state === 'minimized' || barWindow.state === 'minimized') {
            return;
        }

        // Sync bar position to match docked window
        await chrome.windows.update(barWindowId, {
            top: Math.max(dockedWindow.top - BAR_HEIGHT, 0),
            left: dockedWindow.left,
            width: Math.max(dockedWindow.width, 200), // Ensure minimum width
            state: 'normal'
        });
    } catch (e) {
        console.error('Failed to sync bar position:', e);
    }
}

async function createBar() {
    try {
        // Safety check: verify bar doesn't already exist
        if (barWindowId !== null) {
            try {
                const existingBar = await getWindow(barWindowId);
                if (existingBar) {
                    console.warn('Bar window already exists, focusing it instead');
                    await chrome.windows.update(barWindowId, { focused: true });
                    return;
                }
            } catch (e) {
                // Bar window no longer exists, safe to create new one
                barWindowId = null;
            }
        }

        // 1. Get Current Window
        const currentWindow = await getLastFocusedWindow({ windowTypes: ['normal'] });

        // 2. Get Display Info for Precise Geometry
        const displayInfo = await chrome.system.display.getInfo();

        // Find target display
        let targetDisplay = displayInfo[0];
        if (currentWindow) {
            const cx = currentWindow.left + (currentWindow.width / 2);
            const cy = currentWindow.top + (currentWindow.height / 2);
            targetDisplay = displayInfo.find(d => {
                const b = d.bounds;
                return cx >= b.left && cx <= (b.left + b.width) &&
                    cy >= b.top && cy <= (b.top + b.height);
            }) || displayInfo[0];
        }

        const workArea = targetDisplay.workArea;
        const BAR_HEIGHT = 80;

        // 3. Save Original Bounds & State
        if (currentWindow && currentWindow.id) {
            dockedWindowId = currentWindow.id;
            chrome.storage.local.set({ dockedWindowId });
            lastDockedState = currentWindow.state;
            originalBounds = {
                id: currentWindow.id,
                top: currentWindow.top,
                left: currentWindow.left,
                width: currentWindow.width,
                height: currentWindow.height,
                state: currentWindow.state
            };

            // 4. Undock/Resize Browser
            // Must unmaximize to move
            if (currentWindow.state === 'maximized') {
                await chrome.windows.update(dockedWindowId, { state: 'normal' });
            }

            // Apply new bounds
            await chrome.windows.update(dockedWindowId, {
                top: workArea.top + BAR_HEIGHT,
                left: workArea.left,
                width: workArea.width,
                height: workArea.height - BAR_HEIGHT,
                state: 'normal'
            });
        }

        // 5. Create Bar Window
        const win = await chrome.windows.create({
            url: "bar.html",
            type: "popup",
            height: BAR_HEIGHT,
            width: workArea.width,
            top: workArea.top,
            left: workArea.left,
            focused: true
        });
        barWindowId = win.id;

    } catch (error) {
        console.error("Failed to create bar:", error);
    }
}

async function closeBar() {
    if (barWindowId) {
        try {
            await chrome.windows.remove(barWindowId);
        } catch (e) { }
        barWindowId = null;
    }

    // Restore Main Window
    if (dockedWindowId && originalBounds && originalBounds.id === dockedWindowId) {
        try {
            await chrome.windows.update(dockedWindowId, {
                top: originalBounds.top,
                left: originalBounds.left,
                width: originalBounds.width,
                height: originalBounds.height
            });
            if (originalBounds.state !== 'normal') {
                await chrome.windows.update(dockedWindowId, { state: originalBounds.state });
            }
        } catch (e) {
            console.error("Failed to restore window:", e);
        }
    }

    dockedWindowId = null;
    originalBounds = null;
    chrome.storage.local.remove(['dockedWindowId']);
}

chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === barWindowId) {
        closeBar();
    } else if (windowId === dockedWindowId) {
        // If the browser/docked window closes, close the bar too.
        closeBar();
    }
});

chrome.windows.onBoundsChanged.addListener(async (windowId) => {
    if (!dockedWindowId || !barWindowId || isProcessingBoundsChange) return;
    
    try {
        isProcessingBoundsChange = true;
        
        const dockedWindow = await getWindow(dockedWindowId, { populate: false });
        if (!dockedWindow) return;

        // Handle state changes first (minimize, restore, maximize, etc)
        if (dockedWindow.state !== lastDockedState) {
            lastDockedState = dockedWindow.state;
            
            if (dockedWindow.state === 'minimized') {
                // Minimize the bar too
                await chrome.windows.update(barWindowId, { state: 'minimized' });
            } else {
                // Restore the bar when main window is restored
                await chrome.windows.update(barWindowId, { state: 'normal' });
                // Sync position after restoring
                await syncBarPosition();
            }
            return;
        }

        // Handle position/size changes
        if (windowId === dockedWindowId) {
            await syncBarPosition();
        } else if (windowId === barWindowId) {
            await syncBarPosition();
        }
    } catch (e) {
        console.error('Error syncing bar window state:', e);
    } finally {
        isProcessingBoundsChange = false;
    }
});

// Listen to focus changes to ensure proper state sync and z-order maintenance
chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (!dockedWindowId || !barWindowId) return;
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        externalFocus = true;
        return;
    }

    if (isSyncingFocus) return;

    try {
        // --- Case 1: Bar window gained focus ---
        // Sink docked behind bar, then bring bar back on top.
        if (windowId === barWindowId) {
            externalFocus = false;
            isSyncingFocus = true;
            try {
                const dockedWindow = await getWindow(dockedWindowId, { populate: false }).catch(() => null);
                if (dockedWindow && dockedWindow.state !== 'minimized') {
                    await chrome.windows.update(dockedWindowId, { focused: true });
                    await chrome.windows.update(barWindowId, { focused: true });
                }
            } finally {
                setTimeout(() => { isSyncingFocus = false; }, 200);
            }
            return;
        }

        // --- Case 2: Docked Chrome window gained focus ---
        // Push bar on top, then hand focus back to docked window.
        if (windowId === dockedWindowId) {
            externalFocus = false;
            isSyncingFocus = true;
            try {
                const barWindow = await getWindow(barWindowId, { populate: false }).catch(() => null);
                if (barWindow && barWindow.state !== 'minimized') {
                    await chrome.windows.update(barWindowId, { focused: true });
                    await chrome.windows.update(dockedWindowId, { focused: true });
                }
            } finally {
                setTimeout(() => { isSyncingFocus = false; }, 200);
            }
            return;
        }

        if (externalFocus) {
            externalFocus = false;
        }

        // --- Case 3: A THIRD Chrome window gained focus ---
        // This can cause the bar to be pushed behind it.
        const focusedWindow = await getWindow(windowId, { populate: false }).catch(() => null);
        if (!focusedWindow) return;

        const barWindow = await getWindow(barWindowId, { populate: false }).catch(() => null);
        if (!barWindow) return;

        if (barWindow.state === 'minimized') {
            // Bar was minimized — restore if the docked window is visible.
            scheduleRestoreMinimizedBar();
            return;
        }

        // Bar is visible but now buried under the third window.
        // Re-assert z-order: bar -> third window, then restore user focus.
        isSyncingFocus = true;
        try {
            await chrome.windows.update(barWindowId, { focused: true });
            await chrome.windows.update(windowId, { focused: true });
        } finally {
            setTimeout(() => { isSyncingFocus = false; }, 200);
        }

    } catch (e) {
        console.error('Error in focus change handler:', e);
        isSyncingFocus = false;
    }
});
