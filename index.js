'use strict';

// Electron
const {ipcMain, app, BrowserWindow} = require('electron');
const path = require('path');
const url = require('url');
const logger = require('electron-log');
const config = require('./config.json');

// Logger settings
logger.transports.file.level = true;
logger.transports.file.file = config.logFile || __dirname + '/log.txt';
logger.transports.file.maxSize = 1024 * 1024;

let debug = /--debug/.test(process.argv[2]);
let relaunch;

process.argv.forEach(function(argv, index) {
    relaunch = /--relaunch/.test(argv);
    logger.info(`argv[${index}]: ${argv}`);
});

/**
 * Creates Electron Window
*/
function createWindow() {
    logger.info(`[ELECTRON] Create Window`);
    // Create the browser window.
    let win = new BrowserWindow({
        kiosk: !debug,
        height: 480
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

            // Tell renderer if it is a relaunch
            relaunch && win.webContents.send('relaunch');
        });

    // Emitted when the window is closed.
    win.on('closed', () => win = null);
}

// Workarround for https://github.com/electron/electron-quick-start/issues/224
app.disableHardwareAcceleration();

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

app.on('activate', function() {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (win === null) {
        createWindow();
    }
});

ipcMain.on('relaunch', function() {
    logger.info('[MAIN] Received relaunch request');
    // let args = process.argv.slice(1);
    // if (!relaunch) {
    //     args = args.concat(['--relaunch']);
    // }
    // app.relaunch({args: args});
    // app.exit(0);
});
