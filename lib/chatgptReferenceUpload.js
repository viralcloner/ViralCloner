// Runs inside the ChatGPT page; supports the old plus menu and the new composer.
async function openReferenceUploadMenu() {
    const usable = element => element && element.getClientRects().length > 0 &&
        !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    const trigger = Array.from(document.querySelectorAll(
        'button[data-composer-navigation-target="add-context"], #composer-plus-btn'
    )).find(usable);
    if (!trigger) return { success: false, error: 'Attachment menu button not found' };
    trigger.click();
    for (let attempt = 0; attempt < 30; attempt++) {
        const items = Array.from(document.querySelectorAll(
            '[data-composer-overlay-floating-ui] button, [role="menu"] [role="menuitem"], [role="menuitem"], [data-testid="composer-menu-upload-file"]'
        ));
        const upload = items.find(item => usable(item) &&
            !/library|biblioth/i.test(item.textContent || '') && (
            item.getAttribute('data-testid') === 'composer-menu-upload-file' ||
            /^(?:add (?:photos|files)(?: and| or| &)?|upload (?:from computer|photos|files)|ajouter des photos|importer depuis l[’']ordinateur)/i.test(
                (item.textContent || item.getAttribute('aria-label') || '').trim()
            )
        ));
        if (upload) {
            upload.click();
            return { success: true };
        }
        // Older composers mount their file input as soon as the plus menu opens.
        if (attempt >= 5 && document.querySelector('input[type="file"]')) return { success: true };
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return { success: false, error: 'Add photos or files option not found' };
}

async function attachChatGPTReferenceImage(client, imagePath) {
    const { Page, Runtime, DOM } = client;
    let chooser = null;
    const onChooser = event => { chooser = event; };
    await DOM.enable();
    client.on('Page.fileChooserOpened', onChooser);
    try {
        await Page.setInterceptFileChooserDialog({ enabled: true });
        const result = await Runtime.evaluate({
            expression: `(${openReferenceUploadMenu.toString()})()`,
            awaitPromise: true, returnByValue: true, timeout: 10000,
        });
        if (!result.result?.value?.success) {
            throw new Error(result.result?.value?.error || 'Could not open image attachment menu');
        }
        for (let attempt = 0; attempt < 30; attempt++) {
            if (chooser?.backendNodeId) {
                await DOM.setFileInputFiles({ backendNodeId: chooser.backendNodeId, files: [imagePath] });
                return;
            }
            const doc = await DOM.getDocument();
            const input = await DOM.querySelector({ nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
            if (input.nodeId) {
                await DOM.setFileInputFiles({ nodeId: input.nodeId, files: [imagePath] });
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        throw new Error('Reference image file input not found');
    } finally {
        client.removeListener('Page.fileChooserOpened', onChooser);
        await Page.setInterceptFileChooserDialog({ enabled: false }).catch(() => {});
    }
}

module.exports = { openReferenceUploadMenu, attachChatGPTReferenceImage };
