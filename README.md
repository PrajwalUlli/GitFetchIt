# 🚀 GitFetchIt

**GitFetchIt** is a browser extension that lets you download specific files or folders from GitHub repositories — without cloning the entire repo.

---

## 🎥 Demo

![Demo](assets/showcase.gif)

---

## ✨ Features

- 📦 Download **single or multiple files**
- 🗂️ Select and download **entire folders**
- ⚡ One-click download as a **ZIP file**
- 🧭 **Popup UI** to access and download without opening the repo page
- 🔢 Limits for stability:
  - Max selection: **10 items**
  - Max files per download: **10,000**
- 🌐 Works directly on **github.com**
- A nice popup UI to use instead of visiting the repo directly

---

## Screenshots

| Firefox | Chrome |
|--------|--------|
| ![Firefox](assets/firefox.png) | ![Chrome](assets/chrome.png) |

---

## Compatibility

- **Chrome** (Manifest V3)
- **Firefox** (Manifest V2)

---

## Build

Install dependencies:

```bash
npm install
```

Build for Chrome:
```bash
npm run build
```

Build for firefox

```bash
npm run build:firefox
```

---

## Installation

### Chrome

1. Clone or download this repository
2. Go to `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the extension folder

### Firefox

1. Clone or download this repository
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on**
4. Select the `manifest.json` file or the zip thats generated in `.output` folder

---

## Usage

1. Open any repository on GitHub
2. Select files or folders using the extension UI
3. Click **Download**
4. Get a ZIP file instantly 🎉
5. Or use the Popup UI by clicking the extension icon.

---

## Limitations

- Only supports **github.com**
- Max selection: **10 items**
- Max files per download: **10,000**

---

## Inspiration

- https://github.com/git-download-manager/gitd-extension

---

## Acknowledgements

Built as a vibecoded project with help from Claude.

---

## Contributing

Contributions are welcome!  
Feel free to open issues or submit pull requests.

---

## Licence

See LICENSE for more details.
