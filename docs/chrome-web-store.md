# Chrome Web Store submission

Answers for the Chrome Web Store developer dashboard. Build the upload with `npm run package:store`, which writes `dist/agent-computer-use-extension-<version>.zip` without the development `key`.

## Listing

- **Name:** Agent Computer Use
- **Publisher:** Custom Services Limited
- **Summary:** Lets local coding agents work in background tabs of your Chrome, grouped per task, without remote debugging.
- **Category:** Developer Tools
- **Homepage and support:** https://github.com/konstantinosbotonakis/agent-computer-use
- **Privacy policy:** https://github.com/konstantinosbotonakis/agent-computer-use/blob/main/PRIVACY.md

## Single purpose

Let AI coding agents running on the user's own computer open, read and operate browser tabs in the background, in tab groups named after their task, while the user keeps working in other tabs.

## Permission justifications

- **debugger:** Required to read page content and send clicks and key presses to the tabs that a local agent opened or that the user asked it to use. The extension attaches only to those tabs and detaches after two idle minutes. Chrome shows its debugging notice while attached, and dismissing it stops the agent on that tab.
- **nativeMessaging:** The only connection to the local Agent Computer Use program, which the user installs separately and which passes commands from the user's coding agents. The program accepts connections only from processes of the same user account.
- **tabGroups:** Keeps each task's tabs together in a named tab group, apart from the user's own tabs.
- **tabs:** Reads tab titles and URLs so an agent can list open tabs and the popup can show which tabs agents control.

No host permissions are requested.

## Remote code

Answer **No, I am not using remote code**, with this note: all extension code is packaged in the extension. Local agents send Chrome DevTools Protocol commands through native messaging, including JavaScript expressions they evaluate in tabs they control through `chrome.debugger`. Nothing is downloaded from a server, and the extension never runs strings as code in its own context.

## Data usage

Select **Website content** and **Web history**, because the extension reads page content and tab URLs for the user's local agents. Certify that the data is not sold, not used for unrelated purposes and not used for creditworthiness. It is sent only to the local program on the same device, as described in the privacy policy.

## Images

All images are in `store/images` and are rendered from the HTML in `store/` with `node scripts/render-store-images.mjs`.

- **Icon:** `extension/icons/icon-128.png` is part of the package. Its artwork is 96×96 with 16 pixels of transparent padding on each side.
- **Screenshots (1280×800):** `screenshot-1-tab-groups.png`, `screenshot-2-page-outline.png`, `screenshot-3-control.png` and `screenshot-4-setup.png`. The pages, sites and data shown are made-up examples.
- **Small promotional tile (440×280):** `promo-small.png`.

## After the first upload

The store assigns its own extension ID. Register it with the native host on each machine:

```sh
npx @csltd/agent-computer-use install --extension-id <store extension id>
```

To keep the unpacked development build on the same ID, copy the public key from the dashboard's **Package** tab into the `key` field of `extension/manifest.json` and update `EXTENSION_ID` in `src/paths.mjs`.
