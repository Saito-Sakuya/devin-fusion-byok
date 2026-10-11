'use strict';
const path = require('node:path');
const fs = require('node:fs');
// Explicit opt-in for Windows/custom installations; never changes the app.
const configured = process.env.BYOK_TEST_DEVIN_APP_ROOT;
if (configured && (!path.isAbsolute(configured) || !fs.existsSync(configured))) throw new Error('Invalid BYOK_TEST_DEVIN_APP_ROOT');
const appRoot = configured || '/Applications/Devin.app/Contents/Resources/app';
module.exports = { appRoot, rendererFile: path.join(appRoot, 'out/vs/workbench/windsurf-chat-client/index.js'),
  nativeAcpPath: path.join(appRoot, 'node_modules/@exa/windsurf-acp/index.cjs') };
