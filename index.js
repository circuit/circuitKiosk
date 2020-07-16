'use strict';

// Electron
const {app, BrowserWindow} = require('electron');
const path = require('path');
const url = require('url');
const logger = require('electron-log');
const config = require('./config.json');

// Logger settings
logger.transports.file.level = true;
logger.transports.file.file = config.logFile || __dirname + '/log.txt';
logger.transports.file.maxSize = 1024 * 1024;

let debug = /--debug/.test(process.argv[2]);
let kiosk =  /--kiosk/.test(process.argv[2]);
let win;
/**
 * Creates Electron Window
*/
function createWindow() {
    logger.info(`[ELECTRON] Create Window`);
    // Create the browser window.
    win = new BrowserWindow({
        kiosk: kiosk,
        webPreferences: {
            nodeIntegration: true
        }
    });

    // and load the index.html of the app.
    win.loadURL(url.format({
        pathname: path.join(__dirname, 'index.html'),
        protocol: 'file:',
        slashes: true,
    }));

    // Open the DevTools in debug mode
    debug && win.webContents.on('did-frame-finish-load', () => {
            win.webContents.openDevTools();
        });

    // Emitted when the window is closed.
    win.on('closed', () => win = null);
}

// Workarround for https://github.com/electron/electron-quick-start/issues/224
if (debug) {
    app.disableHardwareAcceleration();
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed.
app.on('window-all-closed', () => {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (win === null) {
        createWindow();
    }
});
