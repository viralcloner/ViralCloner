# ViralCloner for Windows

A desktop workspace for building content workflows, managing browser profiles, and creating and editing media.

ViralCloner runs locally without a ViralCloner account. Local tools are freely available. Application updates and VCBrowser downloads come from GitHub.

[Windows releases](https://github.com/viralcloner/Windows-ViralCloner/releases) | [VCBrowser releases](https://github.com/viralcloner/VCBrowser/releases) | [Report an issue](https://github.com/viralcloner/Windows-ViralCloner/issues)

## Features

- **Visual workflows:** Connect content inputs, processing tools, and publishing outputs in a node editor.
- **Browser profiles:** Organize profiles, proxies, and local profile settings with VCBrowser.
- **Facebook and Pinterest tools:** Manage content workflows, saved posts, and analytics.
- **Media editing:** Work with image templates, video, text, and local media.
- **AI integrations:** Connect supported AI providers using your own credentials.
- **Local workspace:** Keep workflow definitions, notes, and application settings on your computer.
- **GitHub updates:** Check for desktop updates and download the browser runtime separately.

## Install

1. Open [Windows releases](https://github.com/viralcloner/Windows-ViralCloner/releases).
2. When available, download the Windows Setup executable matching your architecture and run it.
3. Open ViralCloner. No ViralCloner sign-in is required.
4. In **Settings**, use the **VCBrowser** download button when you need browser-based tools.
5. Configure the providers and third-party accounts needed by your workflows.

GitHub's **Source code (zip)** download is not a Windows installer. If a release has no Setup asset, a compiled installer has not been published for that release.

## VCBrowser

VCBrowser is downloaded from [viralcloner/VCBrowser](https://github.com/viralcloner/VCBrowser/releases) as a portable Windows ZIP. It is not bundled with the desktop installer.

The application verifies the download's SHA-256 checksum and byte size before extraction. The default installation path is:

```text
%APPDATA%\viralcloner\vcbrowser
```

Existing browser installations are reused. The download action installs a missing browser; it does not automatically replace an installed version.

## Local data and network access

The desktop workspace opens without contacting a ViralCloner service. Requests to `viralcloner.com` and its subdomains are blocked by the application network policy.

UI assets are loaded locally, and the browser-control socket listens only on localhost. Application data is normally stored under:

```text
%APPDATA%\viralcloner
```

Back up this directory before updating or moving an installation. Keep profiles, cookies, credentials, and private workflow data out of Git repositories.

Internet access is still required for GitHub downloads and online integrations. Social networks, AI APIs, mail servers, map services, and other providers have their own requirements and may charge for use. Configured schedules may contact those services automatically. A local workspace does not make third-party services offline or free.

## Development

Use Windows, Node.js 22 or newer, and npm. Native dependencies may require Python and Visual Studio C++ Build Tools.

Clone this repository and install the locked dependencies:

```powershell
git clone https://github.com/viralcloner/Windows-ViralCloner.git
cd Windows-ViralCloner
npm ci
npm start
```

Run checks and build Windows packages with:

```powershell
npm test
npm run pack
npm run dist
```

| Command | Purpose |
| --- | --- |
| `npm start` | Launch the Electron application |
| `npm test` | Run the regression suite |
| `npm run pack` | Create an unpacked Windows build |
| `npm run dist` | Create Windows release artifacts without publishing them |

The source project uses `main.js` for Electron startup, `preload.js` for the renderer bridge, `lib/` for application services, `automations/` for workflow nodes, and `frontend/` for the interface.

## Updates and releases

Desktop updates use stable releases from this repository. Installing an offered update requires the user to choose it.

Maintainers should publish a matching version tag such as `v1.8.5` and attach the Windows installer using this naming convention:

```text
ViralCloner-Setup-VERSION-x64.exe
```

Browser builds belong in the separate VCBrowser repository, using an asset name such as `VCBrowser-win-x64.zip`. Both download types require a matching size and GitHub-provided SHA-256 asset digest. Draft releases and prereleases are ignored by the downloader.

For migration of encrypted data from older installations, the previous encryption key can be supplied privately through `VIRALCLONER_LEGACY_ENCRYPTION_KEY`. Fresh installations do not need it. Never commit this value. Portable workflow exports are shareable files; their format does not protect confidential contents.

## Contributing and support

Use [GitHub Issues](https://github.com/viralcloner/Windows-ViralCloner/issues) to report bugs or suggest improvements. Include the app version, Windows version, steps to reproduce, and the relevant error message. Remove credentials and personal information from logs and screenshots.

For source changes, keep commits focused, run the regression suite, and exercise the affected workflows. Update English, French, and Arabic translations when changing interface text. Never commit browser profiles, sessions, private configuration, or generated build files.

## License and third-party components

The desktop application's own source uses the **ISC license**. The complete source distribution includes `LICENSE` and `THIRD_PARTY_NOTICES.md`; dependencies and bundled assets retain their respective licenses.

VCBrowser is a separate distribution. Its source availability, build instructions, bundled components, and licensing must be documented by that repository. A browser ZIP alone does not establish that every included component is open source. The application's ISC license does not relicense external browsers or third-party services.
