/**
 * Facebook Warning Dialog Helper
 *
 * Silently dismisses any "We suspect automated behavior" (or similar)
 * overlay that Facebook shows after navigating to a page.
 *
 * Works without knowing button text, language, or exact DOM structure.
 * Never throws — if no dialog is found it returns false and the caller continues.
 */

const MODULE = "[FBDialogHelper]";

/**
 * Try to dismiss any visible Facebook warning/interstitial overlay.
 *
 * @param {object} Runtime  - CDP Runtime domain (already attached)
 * @returns {Promise<boolean>}  true if a dialog was dismissed, false if none found
 */
async function dismissFacebookWarningDialog(Runtime) {
  try {
    const result = await Runtime.evaluate({
      expression: `
        (() => {
          // Strategy 1: Escape key — least invasive, works before DOM settles
          try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
            document.dispatchEvent(new KeyboardEvent('keyup',  { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
          } catch(_) {}

          // Helper: is element visible?
          function isVisible(el) {
            if (!el || !el.offsetParent) return false;
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
          }

          // Strategy 2: click the first visible [role="button"] inside a [role="dialog"]
          const dialogs = document.querySelectorAll('[role="dialog"]');
          for (const dialog of dialogs) {
            const btns = dialog.querySelectorAll('[role="button"], button');
            for (const btn of btns) {
              if (isVisible(btn)) {
                btn.click();
                return true;
              }
            }
          }

          // Strategy 3: click first visible [role="button"] inside a high-z-index ancestor
          const allBtns = document.querySelectorAll('[role="button"], button');
          for (const btn of allBtns) {
            if (!isVisible(btn)) continue;
            let el = btn.parentElement;
            while (el && el !== document.body) {
              const z = parseInt(window.getComputedStyle(el).zIndex, 10);
              if (!isNaN(z) && z > 100) {
                btn.click();
                return true;
              }
              el = el.parentElement;
            }
          }

          return false;
        })()
      `,
      returnByValue: true,
      timeout: 5000,
    });

    const dismissed = result?.result?.value === true;
    if (dismissed) {
      console.log(`${MODULE} Dismissed warning dialog`);
      // Small pause to let the overlay animate out before continuing
      await new Promise(r => setTimeout(r, 800));
    } else {
      console.log(`${MODULE} No dialog found`);
    }
    return dismissed;
  } catch (err) {
    // Never crash the caller
    console.warn(`${MODULE} Error during dialog dismiss (ignored):`, err.message);
    return false;
  }
}

module.exports = { dismissFacebookWarningDialog };
