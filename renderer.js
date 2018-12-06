const config = require('./config.json');
const packjson = require('./package.json');
const Commander = require('./commandProcess');
const util = require('util');
const {states, BotState} = require('./botState');
const logger = require('electron-log');
const {ipcRenderer} = require('electron');
const fs = require('fs');
const Circuit = require('circuit-sdk/circuit.js');
const GpioHelper = require('./gpioWrapper');

// UI States
const SPLASH = 'SPLASH';
const USERS = 'USERS';
const CALL = 'CALL';
const CALLING = 'CALLING';

// Max Users that can be display on the screen
const MAX_USERS = 16;

// Presence detection time to switch to USERS screen
const SWITCH_TO_USERS_TIME = 1000; // 1 second
// Time to switch back to splash screen after no more presence
const SWITCH_BACK_TO_SPLASH = 20000; // 5 seconds
// Time the door is kept unlock
const DOOR_UNLOCK_TIME = 2000; // 2 seconds
// Interval to update hygrotermo data
const UPDATE_HYGROTERMO_INTERVAL = 30000; // 30 seconds
// Time before starting motion detection
const TIME_DETECTION_START_DELAY = 10000; // 10 seconds
// Time after last typing before starting motion detection again
const RESTART_MOTION_DETECTION_TIME = 10000; // 10 seconds

let uiData = {
    status: SPLASH,
    users: [],
    searchId: null,
    receptionist: config.receptionist,
    switchViewTimer: null
};

process.argv.forEach(function(argv, index) {
    logger.info(`argv[${index}]: ${argv}`);
});

let Bot = function(client) {
    let self = this;
    let commander = new Commander(logger);
    let gpioHelper = new GpioHelper(logger);
    let botState = new BotState(states.INITIALIZING, logger);
    let currentCall;
    let user;
    let relaunch;
    let uiElements = {};
    let motionDetectorIndex;
    let motionDetectionDelay;
    let receptionConv;

    ipcRenderer.on('relaunch', () => {
        logger.info('[MONAS]: Received relaunch');
        relaunch = true;
    });

    /*
     * Logon Client
     */
    this.logonBot = function() {
        return new Promise((resolve) => {
            let retry;
            self.addEventListeners(client);
            self.initUI();
            self.updateUI();
            let logon = async function() {
                try {
                    user = await client.logon();
                    clearInterval(retry);
                    resolve();
                } catch (error) {
                    logger.error(`[MONAS]: Error logging Bot. Error: ${error}`);
                }
            };
            logger.info(`[MONAS]: Create bot instance with id: ${config.bot.client_id}`);
            retry = setInterval(logon, 2000);
        });
    };

    this.startSensors = function(motionSensingDelay, initialLedStatus) {
        return new Promise((resolve) => {
            gpioHelper.initMotionSensor();
            setTimeout(function() {
                motionDetectorIndex = gpioHelper.subscribeToMotionDetection(self.motionChange, GpioHelper.MODE_BOTH);
            }, motionSensingDelay || TIME_DETECTION_START_DELAY);
            gpioHelper.initLED();
            gpioHelper.initBuzzer();
            gpioHelper.setLED(initialLedStatus || GpioHelper.STATUS_OFF);
            gpioHelper.setBuzzer(GpioHelper.STATUS_OFF);
            self.startHygroTermInterval();
            resolve();
        });
    };

    this.getReceptionConversation = async function() {
        let convId = config.receptionist && config.receptionist.groupConvId;
        if (convId) {
            try {
                receptionConv = await client.getConversationById(config.convId);
            } catch (error) {
                logger.error(`[MONAS]: Unable to retrieve receptionist conversation. Error: ${error}`);
            }
        }
        return;
    };

    /*
     * Update user display name if needed
     */
    this.updateUserData = async function() {
        if (user && user.displayName !== `${config.bot.first_name} ${config.bot.last_name}`) {
            // Need to update user data
            try {
                await client.updateUser({
                    userId: user.userId,
                    firstName: config.bot.first_name,
                    lastName: config.bot.last_name,
                });
                user.firstName = config.bot.first_name;
                user.lastName = config.bot.last_name;
                user.displayName = `${config.bot.first_name} ${config.bot.last_name}`;
            } catch (error) {
                logger.error(`[MONAS]: Unable to update user data. Error: ${error}`);
            }
        }
        return user;
    };

    /*
     * addEventListeners
     */
    this.addEventListeners = function(client) {
        logger.info('[MONAS]: addEventListeners');
        Circuit.supportedEvents.forEach(function(e) {
            client.addEventListener(e, self.processEvent);
        });
    };

    /*
     * logEvent
     */
    this.logEvent = function(evt) {
        logger.info(`[MONAS]: ${evt.type} event received`);
        logger.debug(`[MONAS]:`, util.inspect(evt, {showHidden: true, depth: null}));
    };

    /*
     * getConversation
     */
    this.getConversation = async function() {
        let conv;
        if (config.convId) {
            logger.info(`[MONAS]: Check if conversation ${config.convId} exists`);
            try {
                conv = await client.getConversationById(config.convId);
                if (conv) {
                    logger.info(`[MONAS]: conversation ${conv.convId} exists`);
                    return conv;
                }
            } catch (error) {
                logger.error(`[MONAS] Unable to get configured conversation. Error: ${error}`);
            }
        }
        logger.info('[MONAS]: Conversation not configured or it does not exist. Find direct conv with owner');
        return client.getDirectConversationWithUser(config.botOwnerEmail, true);
    };

    /*
     * say Hi
     */
    this.sayHi = async function() {
        if (botState.getState() === states.INITIALIZING) {
            botState.setState(states.IDLE);
        }
        if (relaunch) {
            logger.info('[NOMAS]: Relaunching app. Do not say hi');
            return;
        }
        logger.info('[MONAS]: say hi');
        let conv = await self.getConversation();
        client.addTextItem(conv.convId, self.buildConversationItem(null, `Hi from ${user.displayName}`,
            `I am ready. Use "@${user.displayName} help , or ${user.displayName} help, or just //help" to see available commands`));
    };

    /*
     * buildConversationItem
     */
    this.buildConversationItem = function(parentId, subject, content, attachments) {
        return {
            parentId: parentId,
            subject: subject,
            content: content,
            contentType: Circuit.Constants.TextItemContentType.RICH,
            attachments: attachments && [attachments],
        };
    };

    /*
     * terminate
     */
    this.terminate = function(err) {
        let error = new Error(err);
        logger.error(`[MONAS]: bot failed ${error.message}`);
        logger.error(error.stack);
        process.exit(1);
    };

    /*
     * processEvent
    */
    this.processEvent = function(evt) {
        self.logEvent(evt);
        switch (evt.type) {
            case 'itemAdded':
                self.processItemAddedEvent(evt);
                break;
            case 'itemUpdated':
                self.processItemUpdatedEvent(evt);
                break;
            case 'callStatus':
                self.processCallStatusEvent(evt);
                break;
            case 'callEnded':
                self.processCallEndedEvent(evt);
                break;
            case 'callIncoming':
                self.processCallIncomingEvent(evt);
                break;
            case 'basicSearchResults':
                self.processSearchResults(evt.data).then(self.updateUI);
                break;
            default:
                logger.info(`[MONAS]: unhandled event ${evt.type}`);
                break;
        }
    };

    /*
     * processItemAddedEvent
     */
    this.processItemAddedEvent = function(evt) {
        if (evt.item.text && evt.item.creatorId !== user.userId) {
            logger.info(`[MONAS] Received itemAdded event with itemId [${evt.item.itemId}] and content [${evt.item.text.content}]`);
            self.processCommand(evt.item.convId, evt.item.parentItemId || evt.item.itemId, evt.item.text.content);
        }
    };

    /*
     * processItemUpdatedEvent
     */
    this.processItemUpdatedEvent = function(evt) {
        if (evt.item.text && evt.item.creatorId !== user.userId) {
            if (evt.item.text.content) {
                let lastPart = evt.item.text.content.split('<hr/>').pop();
                logger.info(`[MONAS] Received itemUpdated event with: ${lastPart}`);
                self.processCommand(evt.item.convId, evt.item.parentItemId || evt.item.itemId, lastPart);
            }
        }
    };

    /*
     * processCallStatusEvent
     */
    this.processCallStatusEvent = async function(evt) {
        logger.info(`[MONAS]: callStatus event: Reason= ${evt.reason}, State= ${currentCall && currentCall.state} ==> ${evt.call.state}`);
        logger.info(`[MONAS]: Bot state: ${botState.getStateText()}`);

        if (currentCall && currentCall.callId !== evt.call.callId) {
            // Event is not for current call
            logger.info('[MONAS]: Received event for a different call');
            return;
        }

        if (!currentCall) {
            if (evt.call.state === 'Started') {
                // Conference started. Join.
                let conv = await client.getConversationById(evt.call.convId);
                this.startConference(conv, evt.call.callId);
            }
        } else if (evt.call.state === 'Waiting') {
            let st = botState.getState();
            if (st === states.INCALL) {
                // Leave conference if not more participants
                client.leaveConference(evt.call.callId);
            } else if (st == states.STARTCONF) {
                // Ring all participants
                botState.setState(states.ALERTING);
                client.getConversationById(evt.call.convId).then((conv) => {
                    conv.participants.forEach((userId) => {
                        logger.info(`[MONAS] Check is ${userId} is already in the call`);
                        if (evt.call.participants.indexOf(userId) === -1 && userId !== user.userId) {
                            logger.info(`[MONAS] Alerting user with userId ${userId}`);
                            client.addParticipantToCall(evt.call.callId, {userId: userId}, true)
                            .then(() => logger.info(`[MONAS] ${userId} has been alerted that conference is in progress`))
                            .catch(() => logger.error(`[MONAS] Error adding ${userId} to the conference.`));
                        }
                    });
                });
            }
        } else if (currentCall.state !== 'Active' && evt.call.state === 'Active') {
            // At least two participants. Me and someelse. Setup Media.
            self.setupMedia(evt.call);
            botState.setState(states.INCALL);
            uiData.status = CALL;
            self.updateUI();
        } else {
            logger.info(`[MONAS] Unhandled call state: ${evt.call.state}`);
        }
        currentCall = evt.call;
        // Unsubscribe for motion detection
        gpioHelper.unsubscribeFromMotionDetection(motionDetectorIndex);
        motionDetectorIndex = null;
        if (uiData.switchViewTimer) {
            clearTimeout(uiData.switchViewTimer);
        }
    };

    /*
     * processCallIncomingEvent
     */
    this.processCallIncomingEvent = async function(evt) {
        if (currentCall && currentCall.callId !== evt.call.callId) {
            // Event is not for current call
            logger.info('[MONAS]: Received event for a different call');
            return;
        }

        if (!currentCall) {
            // Incoming call. Answer it.
            let conv = await client.getConversationById(evt.call.convId);
            this.startConference(conv, evt.call.callId);
        }
        currentCall = evt.call;
    };

    /*
     * processCallEndedEvent
     */
    this.processCallEndedEvent = function(evt) {
        if (evt.call.callId === currentCall.callId /*&& botState.getState() === states.INCALL*/) {
            // ipcRenderer.send('relaunch');
            // process.exit(1);
            currentCall = null;
            botState.setState(states.IDLE);
            uiData.status = SPLASH;
            self.updateUI();
            motionDetectorIndex = gpioHelper.subscribeToMotionDetection(self.motionChange, GpioHelper.MODE_BOTH);
        }
    };

    /*
     * isItForMe?
     */
    this.isItForMe = function(command) {
        logger.info(`Full Command [${command}]`);
        logger.info(`Display Name: [${user.displayName}]`);
        if (command.indexOf('mention') !== -1) {
            return command.substr(command.indexOf('</span> ') + 8);
        } else if (command.indexOf(user.displayName) !== -1) {
            return command.substr(command.indexOf(user.displayName) + user.displayName.length + 1);
        } else if (command.indexOf('//') === 0) {
            return command.substr(command.indexOf('//') + 2);
        }
        return;
    };

    /*
     * Process command
     */
    this.processCommand = function(convId, itemId, command) {
        logger.info(`[MONAS] Processing command: [${command}]`);
        let withoutName = self.isItForMe(command);
        if (withoutName) {
            logger.info(`[MONAS] Command is for me. Processing [${withoutName}]`);
            commander.processCommand(withoutName, async (reply, params) => {
                logger.info(`[MONAS] Interpreting command to ${reply} with parms ${JSON.stringify(params)}`);
                switch (reply) {
                    case 'status':
                        self.reportStatus(convId, itemId);
                        break;
                    case 'version':
                        self.reportVersion(convId, itemId);
                        break;
                    case 'showHelp':
                        self.showHelp(convId, itemId, params);
                        break;
                    case 'start':
                        let conv = await client.getConversationById(convId);
                        self.startConference(conv);
                        break;
                    case 'stop':
                        currentCall && client.leaveConference(currentCall.callId);
                        ipcRenderer.send('relaunch');
                        // ipcRenderer.send('relaunch');
                        // process.exit(1);
                        currentCall = null;
                        botState.setState(states.IDLE);
                        break;
                    case 'dial':
                        self.dial(convId, itemId, params);
                        break;
                    case 'getLogs':
                        self.getLogFile(convId, itemId);
                        break;
                    case 'search':
                        self.searchUsers(convId, itemId, params && params[0], true);
                        break;
                    case 'switchView':
                        uiData.status = params[0];
                        self.updateUI();
                        break;
                    case 'openDoor':
                        self.openDoor(convId, itemId);
                        break;
                    case 'getTemp':
                        gpioHelper.readTempAndHumidity(function(temp, humidity) {
                            client.addTextItem(convId, self.buildConversationItem(itemId, null,
                                `Temperature: ${temp}, humidity: ${humidity}`));
                        });
                        break;
                    default:
                        logger.info(`[MONAS] I do not understand [${withoutName}]`);
                        client.addTextItem(convId, self.buildConversationItem(itemId, null,
                            `I do not understand <b>[${withoutName}]</b>`));
                        break;
                }
            });
        } else {
            logger.info('[MONAS] Ignoring command: it is not for me');
        }
    };

    /*
     * Gets Log File
     */
    this.getLogFile = function(convId, itemId) {
        fs.readFile(config.logFile, 'utf8', function(err, data) {
            if (err) {
                sendErrorItem(convId, itemId, 'Unable to read log file');
                return;
            }
            let file = new File([data], config.logFile, {type: 'text/plain'});
            client.addTextItem(convId, self.buildConversationItem(itemId, 'LOGS', 'Here are my logs', file));
        });
        return;
    };

    /*
     * Report bot status
     */
    this.reportStatus = function(convId, itemId) {
        client.addTextItem(convId, self.buildConversationItem(itemId, null,
            `Status <b>${botState.getStateText()}</b>`));
    };

    /*
     * Report software versions
     */
    this.reportVersion = function(convId, itemId) {
        client.addTextItem(convId, self.buildConversationItem(itemId, null,
            `App: <b>${packjson.version}</b>, Node: <b>${process.versions.node}</b>, Electron: <b>${process.versions.electron}</b>` +
            `, Chrome: <b>${process.versions.chrome}</b>, v8: <b>${process.versions.v8}</b>`));
    };

    /*
     * Show bot available commands
     */
    this.showHelp = function(convId, itemId, params) {
        logger.info('[MONAS] Displaying help...');
        commander.buildHelp(params && params.length && params[0]).then((help) =>
            client.addTextItem(convId, self.buildConversationItem(itemId, 'HELP', help)));
    };

    /*
     * Show an error as a conversation item
     */
    this.sendErrorItem = function(convId, itemId, err) {
        client.addTextItem(convId, self.buildConversationItem(itemId, 'ERROR', err));
    };

    /**
     * Helper sleep function
     * @param {int} ms
     * @return {Promise}
     */
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /*
     * dial phone number
     */
    this.dial = async function(convId, itemId, params) {
        if (!params || !params.length) {
            logger.error(`[MONAS] No number to dial`);
            self.sendErrorItem(convId, itemId, 'Unable to dial. Phone number missing');
            return;
        }
        try {
            logger.info(`[MONAS] Dialling number ${params[0]}`);
            currentCall = await client.dialNumber(params[0], null, {audio: true, video: false});
            botState.setState(states.DIALLING);
        } catch (error) {
            self.sendErrorItem(convId, itemId, `Error dialing number ${params[0]}. Error: ${error}`);
            logger.error(`[MONAS] Error dialing number ${params[0]}. Error: ${error}`);
        }
    };

    /*
     * Start Circuit Conference
     */
    this.startConference = async function(conv, callId) {
        try {
            let call = await client.findCall(callId);
            if (!call) {
                if (conv.type !== Circuit.Enums.ConversationType.DIRECT) {
                    call = await client.startConference(conv.convId, {audio: true, video: true});
                    botState.setState(states.STARTCONF);
                } else {
                    conv.participants.forEach(async function(participant) {
                        if (participant !== user.userId) {
                            call = await client.makeCall(participant, {audio: true, video: true});
                            botState.setState(states.STARTCONF);
                        }
                    });
                }
            } else if (conv.type === Circuit.Enums.ConversationType.DIRECT) {
                client.answerCall(call.callId, {audio: true, video: true});
            } else if (call.isRemote) {
                await client.joinConference(call.callId, {audio: true, video: true});
            }
        } catch (err) {
            logger.error(`${err.name}: ${err.message}`);
        }
    };

    /*
     * Setup Media
     */
    this.setupMedia = async function(call) {
        if (currentCall) {
            // let constraints = {audio: true, video: {width: 1280, height: 720}};
            // let mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

            // For Debugging show on index.html page
            // videoElement = document.querySelector('video');
            // videoElement.srcObject = mediaStream;
            // videoElement.onloadedmetadata = e => videoElement.play();

            let remoteStreams = client.getRemoteStreams(call.callId);
            let remoteAudioStream = remoteStreams.find((s) => s.getAudioTracks().length > 0);
            uiElements.audioElement.srcObject = remoteAudioStream;
            if(call.remoteVideoStreams && call.remoteVideoStreams.length) {
                uiElements.videoElement.srcObject = call.remoteVideoStreams[0].stream;
            }
            // await client.setAudioVideoStream(call.callId, mediaStream);
            await sleep(2000);
            await client.unmute(call.callId);
        }
    };

    /*
     * Search Users
     */
    this.searchUsers = async function(convId, itemId, searchString, test) {
        if (!searchString || !searchString.length) {
            if (test) {
                logger.error(`[MONAS] Invalid Syntax`);
                self.sendErrorItem(convId, itemId, 'Invalid syntax. Sintax: search searchString');
            }
            return;
        }
        uiData.searchId = client.startUserSearch(searchString);
    };

    /*
     * Process Users Search Results
     */
    this.processSearchResults = async function(data) {
        return new Promise(function(resolve) {
            uiData.searchId = null;
            if (!data || !data.users) {
                logger.info(`[MONAS] Nothing to do. No search results`);
                return;
            }
            uiData.users = [];
            data.users.forEach(async function(userId, index) {
                client.getUserById(userId).then((user) => {
                    uiData.users.push(user);
                    logger.info(`[MONAS] User: ${user.firstName} ${user.lastName}`);
                    if (data.users.length === uiData.users.length) {
                        resolve(uiData.users);
                    }
                });
            });
        });
    };

    /*
     * Calls individual user
     */
    this.callUser = function(userIndex) {
        let user = uiData.users[userIndex];
        logger.info(`[MONAS] Calling user ${user.firstName} ${user.lastName}`);
        uiData.callingUser = {
            avatar: user.avatarLarge,
            legend: `Calling ${user.firstName} ${user.lastName}`
        };
        uiData.status = CALLING;
        self.updateUI();
        if (user.isReceptionist) {
            self.startConference(receptionConv);
        } else {
            client.makeCall(user.userId, {audio: true, video: true}, true);
        }
        uiElements.searchString.innerHTML = '';
        uiData.users = [];
        gpioHelper.unsubscribeFromMotionDetection(motionDetectorIndex);
        motionDetectorIndex = null;
    }

    /*
     * Update User Interface
     */
    this.updateUI = function() {
        switch(uiData.status) {
            case SPLASH:
                self.showSplash();
                break;
            case USERS:
                self.showUsers();
                break;
            case CALL:
                self.showCall();
                break;
            case CALLING:
                self.showCalling();
            default:
                logger.error(`[MONAS] Invalud UI Status: ${uiData.status}`);
                break;
        }
        return;
    }

    this.showUsers = function () {
        uiElements.splashLogoStyle.display = 'none';
        uiElements.userSearchStyle.display = 'flex';
        uiElements.callScreenStyle.display = 'none';
        uiData.users = uiData.users || [];
        if (uiData.receptionist && uiData.receptionist.groupConvId && receptionConv) {
            if (uiData.users.length == 0 || !uiData.users[0].isReceptionist) {
                uiData.users.unshift({
                    firstName: uiData.receptionist.firstName,
                    lastName: uiData.receptionist.lastName,
                    avatar: uiData.receptionist.smallPicture,
                    avatarLarge: uiData.receptionist.largePicture,
                    userId: uiData.receptionist.groupConvId,
                    isGroupCall: uiData.receptionist.groupConvId,
                    isReceptionist: true
                });
            }
        }
        uiData.users.forEach(function (user, index) {
            if (index < MAX_USERS) {
                uiElements.usersUI[index].style.display = 'inline-block';
                uiElements.usersUI[index].text.innerHTML = `${user.firstName} ${user.lastName}`;
                uiElements.usersUI[index].avatar.src = user.avatar;
                if (user.isReceptionist) {
                    document.querySelector('#receptionist').style.backgroundColor = '#FF0000';
                }
            }
        });
        if (uiData.users.length < MAX_USERS) {
            for(let i = uiData.users.length; i < MAX_USERS; i++) {
                uiElements.usersUI[i].style.display = 'none';
            }            
        }
    };

    this.showSplash = function () {
        uiElements.splashLogoStyle.display = 'flex';
        uiElements.userSearchStyle.display = 'none';
        uiElements.callScreenStyle.display = 'none';
    };

    this.showCall = function () {
        uiElements.splashLogoStyle.display = 'none';
        uiElements.userSearchStyle.display = 'none';
        uiElements.callScreenStyle.display = 'flex';
        uiElements.videoElement.style.display = 'flex';
        uiElements.callingUser.avatar.style.display = 'none';
        uiElements.callingUser.legend.style.display = 'none';
    };

    this.showCalling = function () {
        uiElements.splashLogoStyle.display = 'none';
        uiElements.userSearchStyle.display = 'none';
        uiElements.callScreenStyle.display = 'flex';
        uiElements.videoElement.style.display = 'none';
        uiElements.callingUser.avatar.src = uiData.callingUser.avatar;
        uiElements.callingUser.legend.innerHTML = uiData.callingUser.legend;
        uiElements.callingUser.avatar.style = 'flex';
    };

    this.initUI = function () {
        uiElements.splashLogoStyle = document.querySelector('#splash_logo').style;
        uiElements.userSearchStyle = document.querySelector('#users_section').style;
        uiElements.callScreenStyle = document.querySelector('#call_screen').style;
        uiElements.usersUI = [];
        for (let i = 0; i < MAX_USERS; i++) {
            let uiUser = {
                style: document.querySelector(`#user_${i}`).style,
                text: document.querySelector(`#user_name_${i}`),
                avatar: document.querySelector(`#user_image_${i}`),
            }
            uiElements.usersUI.push(uiUser);
        }
        uiElements.searchString = document.querySelector('#search_string');
        uiElements.videoElement = document.querySelector('video');
        uiElements.audioElement = document.querySelector('audio');
        uiElements.callingUser = {
            avatar: document.querySelector(`#callingUserAvatar`),
            legend: document.querySelector(`#callingUserLegend`)
        };
        uiElements.callingUserStype = document.querySelector('#calling');
        uiElements.date = document.querySelector('#date');
        uiElements.time = document.querySelector('#time');
        uiElements.temperature = document.querySelector('#temperature');
        uiElements.humidity = document.querySelector('#humidity');

    };

    this.clickKey = function (key) {
        self.unsubscribeMotionDetectionWhileTyping();
        uiElements.searchString.innerHTML += key;
        uiData.searchId = client.startUserSearch(uiElements.searchString.innerHTML);
    };

    this.clickEnter = function () {
        self.unsubscribeMotionDetectionWhileTyping();
        if (uiData.searchId) {
            client.cancelSearch(uiData.searchId);
        }
        if (uiElements.searchString.innerHTML) {
            uiData.searchId = client.startUserSearch(uiElements.searchString.innerHTML);
        }
    };

    this.clickBS = function () {
        self.unsubscribeMotionDetectionWhileTyping();
        if (uiElements.searchString.innerHTML.length) {
            uiElements.searchString.innerHTML = uiElements.searchString.innerHTML.slice(0, uiElements.searchString.innerHTML.length-1);
        }
        if (uiElements.searchString.innerHTML) {
            uiData.searchId = client.startUserSearch(uiElements.searchString.innerHTML);
        } else {
            uiData.users = [];
            self.updateUI();
        }
    };

    this.unsubscribeMotionDetectionWhileTyping = function () {
        gpioHelper.unsubscribeFromMotionDetection(motionDetectorIndex);
        logger.debug('[MONAS]: Unsubscribe motion detection while typing');
        if (uiData.switchViewTimer) {
            clearTimeout(uiData.switchViewTimer);
            uiData.switchViewTimer = null;
        }
        if (motionDetectionDelay) {
            clearTimeout(motionDetectionDelay);
            motionDetectionDelay = null;
        }
        motionDetectionDelay = setTimeout(function() {
            motionDetectorIndex = gpioHelper.subscribeToMotionDetection(self.motionChange, GpioHelper.MODE_BOTH);
            motionDetectionDelay = null;
            self.motionChange(GpioHelper.STATUS_OFF);
        }, RESTART_MOTION_DETECTION_TIME);
    };

    this.motionChange = function(status) {
        logger.debug(`[MONAS] Motion detected status ${status}`);
        if (uiData.switchViewTimer) {
            clearTimeout(uiData.switchViewTimer);
        }
        uiData.switchViewTimer = setTimeout(function () {
            if (uiData.status === USERS && status === GpioHelper.STATUS_ON) {
                return;
            }
            uiData.status = (status == GpioHelper.STATUS_OFF ? SPLASH : USERS);
            uiElements.searchString.innerHTML = '';
            uiData.users = [];
            self.updateUI();
        }, (status === GpioHelper.STATUS_OFF ? SWITCH_BACK_TO_SPLASH : SWITCH_TO_USERS_TIME));
    };

    this.openDoor = function(convId, itemId) {
        if (!currentCall) {
            let error = 'Attempt to open a door without an active call is not possible';
            logger.warn(`[MONAS] ${error}`);
            self.sendErrorItem(convId, itemId, error);
            return;
        }
        gpioHelper.setBuzzer(GpioHelper.STATUS_ON);
        gpioHelper.setLED(GpioHelper.STATUS_ON);
        setTimeout(function (){
            gpioHelper.setBuzzer(GpioHelper.STATUS_OFF);
            gpioHelper.setLED(GpioHelper.STATUS_OFF);
            }, DOOR_UNLOCK_TIME);
    };

    this.startHygroTermInterval = function (interval) {
        let update = function() {
            gpioHelper.readTempAndHumidity(function(temp, humidity) {
                uiElements.humidity.innerHTML = `Humidity: ${humidity}%`;
                uiElements.temperature.innerHTML = `Temperature: ${temp}°`;
                let date = new Date();
                uiElements.date.innerHTML = `Date: ${date.getMonth()+1}/${date.getDate()}`;
                uiElements.time.innerHTML = `Time: ${date.getHours()}:${date.getMinutes()}`;
            });
        }
        update();
        setInterval(function () {
            logger.debug('[MONAS]: Update bottom bar');
            update();
        }, interval || UPDATE_HYGROTERMO_INTERVAL);
    };
};

Circuit.logger.setLevel(Circuit.Enums.LogLevel.Debug);
let bot = new Bot(new Circuit.Client(config.bot));
bot.logonBot()
    .then(bot.updateUserData)
    .then(bot.getReceptionConversation)
    .then(bot.startSensors)
    .catch(bot.terminate);

// Functions invoked from UI
let callUser = bot.callUser;
let clickKey = bot.clickKey;
let clickEnter = bot.clickEnter;
let clickBS = bot.clickBS;