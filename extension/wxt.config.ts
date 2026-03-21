import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'GitFetchIt',
    description: 'Select files and folders from any GitHub repo and download them as a ZIP',
    version: '1.0.0',
    icons: {
      16:  '/icons/icon16.png',
      32:  '/icons/icon32.png',
      48:  '/icons/icon48.png',
      96:  '/icons/icon96.png',
      128: '/icons/icon128.png',
    },
    host_permissions: [
      '*://github.com/*',
      '*://api.github.com/*',
      '*://raw.githubusercontent.com/*',
    ],
    permissions: ['storage'],
  },
});
