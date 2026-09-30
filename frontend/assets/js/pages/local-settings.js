(() => {
    let release = null;
    const t = key => window.I18n.t('local.' + key);
    $('#localCheckUpdates').off('.localUpdates').on('click.localUpdates', async function () {
        $(this).prop('disabled', true);
        $('#localInstallUpdate').hide();
        $('#localUpdateStatus').text(t('checking_updates'));
        try {
            release = await window.electronAPI.checkForUpdates();
            $('#localUpdateStatus').text(release.success
                ? (release.updateAvailable ? t('update_available') + ' ' + release.latestVersion : t('no_update'))
                : release.error);
            $('#localInstallUpdate').toggle(Boolean(release.updateAvailable));
        } catch (error) {
            $('#localUpdateStatus').text(error.message);
        } finally { $(this).prop('disabled', false); }
    });
    $('#localInstallUpdate').off('.localUpdates').on('click.localUpdates', async function () {
        if (!release?.downloadUrl) return;
        $(this).prop('disabled', true);
        const unsubscribe = window.electronAPI.onUpdateDownloadProgress(data => {
            $('#localUpdateStatus').text(`${data.progress}% — ${data.status}`);
        });
        try {
            const result = await window.electronAPI.downloadAndInstallUpdate(release.downloadUrl);
            if (!result.success) $('#localUpdateStatus').text(result.error);
        } catch (error) {
            $('#localUpdateStatus').text(error.message);
        } finally { unsubscribe(); $(this).prop('disabled', false); }
    });
    $('#localViewReleases').off('.localUpdates').on('click.localUpdates', () => {
        window.electronAPI.openExternal('https://github.com/viralcloner/ViralCloner/releases');
    });
})();
