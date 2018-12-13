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
const GcsHelper = require('./gcsWrapper');

// Max Users that can be display on the screen
const MAX_USERS = 20;

// Presence detection time to switch to USERS screen
const PRESENCE_ON_DELAY = 1000; // 1 second
// Time to switch back to splash screen after no more presence
const PRESENCE_OFF_DELAY = 10000; // 10 seconds
// Time the door is kept unlock
const DOOR_UNLOCK_TIME = 2000; // 2 seconds
// Interval to update hygrotermo data
const UPDATE_HYGROTERMO_INTERVAL = 30000; // 30 seconds
// Time before starting motion detection
const RESTART_MOTION_DETECTION_DELAY = 10000; // 10 seconds

process.argv.forEach(function(argv, index) {
    logger.info(`argv[${index}]: ${argv}`);
});

let Bot = function(client) {
    let self = this;
    let commander = new Commander(logger);
    let gpioHelper = new GpioHelper(logger, config.virtualEnvironment);
    let botState = new BotState(states.INITIALIZING, logger);
    let gcsHelper = new GcsHelper(logger);
    let user;
    let motionDetectorIndex;
    let motionDetectionDelay;
    let monitoringConv;
    let app;
    let searchId;
    let motionChangeDelayTimer;

    /*
     * Logon Client
     */
    this.logonBot = function() {
        return new Promise((resolve) => {
            let retry;
            addEventListeners(client);
            initUI(onCallUser, onSearchStringUpdated);
            if (config.gcsKeyFilePathName) {
                gcsHelper.init(config.gcsKeyFilePathName);
            }
            let logon = async function() {
                try {
                    user = await client.logon();
                    clearInterval(retry);
                    resolve();
                } catch (error) {
                    logger.error(`[RENDERER] Error logging Bot. Error: ${error}`);
                }
            };
            logger.info(`[RENDERER] Create bot instance with id: ${config.bot.client_id}`);
            retry = setInterval(logon, 2000);
        });
    };

    this.startSensors = function(motionSensingDelay, initialLedStatus) {
        return new Promise((resolve) => {
            gpioHelper.initMotionSensor();
            setTimeout(function() {
                motionDetectorIndex = gpioHelper.subscribeToMotionDetection(motionChange, GpioHelper.MODE_BOTH);
            }, motionSensingDelay || RESTART_MOTION_DETECTION_DELAY);
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
                receptionConv = await client.getConversationById(convId);
            } catch (error) {
                logger.error(`[RENDERER] Unable to retrieve receptionist conversation. Error: ${error}`);
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
                logger.error(`[RENDERER] Unable to update user data. Error: ${error}`);
            }
        }
        return user;
    };

    /*
     * addEventListeners
     */
    function addEventListeners(client) {
        logger.info('[RENDERER] addEventListeners');
        Circuit.supportedEvents.forEach(function(e) {
            client.addEventListener(e, processEvent);
        });
    };

    /*
     * logEvent
     */
    function logEvent(evt) {
        logger.info(`[RENDERER] ${evt.type} event received`);
        logger.debug(`[RENDERER]`, util.inspect(evt, {showHidden: true, depth: null}));
    };

    /*
     * getConversation
     */
    async function getMonitoringConversation() {
        let conv;
        if (config.monitoringConvId) {
            logger.info(`[RENDERER] Check if conversation ${config.monitoringConvId} exists`);
            try {
                conv = await client.getConversationById(config.monitoringConvId);
                if (conv) {
                    logger.info(`[RENDERER] conversation ${config.monitoringConvId} exists`);
                    return conv;
                }
            } catch (error) {
                logger.error(`[RENDERER] Unable to get configured conversation. Error: ${error}`);
            }
        }
        logger.info('[RENDERER] Conversation not configured or it does not exist. Find direct conv with owner');
        return client.getDirectConversationWithUser(config.botOwnerEmail, true);
    };

    /*
     * say Hi
     */
    this.sayHi = async function() {
        if (botState.getState() === states.INITIALIZING) {
            botState.setState(states.IDLE);
        }
        logger.info('[RENDERER] say hi');
        monitoringConv = await getMonitoringConversation();
        client.addTextItem(monitoringConv.convId, buildConversationItem(null, `Hi from ${user.displayName}`,
            `I am ready. Use "@${user.displayName} help , or ${user.displayName} help, or just //help" to see available commands`));
    };

    /*
     * buildConversationItem
     */
    function buildConversationItem(parentId, subject, content, attachments) {
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
        logger.error(`[RENDERER] bot failed ${error.message}`);
        logger.error(error.stack);
        process.exit(1);
    };

    /*
     * processEvent
    */
    function processEvent(evt) {
        logEvent(evt);
        switch (evt.type) {
            case 'itemAdded':
                processItemAddedEvent(evt);
                break;
            case 'itemUpdated':
                processItemUpdatedEvent(evt);
                break;
            case 'callStatus':
                processCallStatusEvent(evt);
                break;
            case 'callEnded':
                processCallEndedEvent(evt);
                break;
            case 'callIncoming':
                processCallIncomingEvent(evt);
                break;
            case 'basicSearchResults':
                processSearchResults(evt.data).then(users => {
                    app.setUsers(users);
                });
                break;
            case 'formSubmission':
                processFormSubmission(evt);
                break;
            default:
                logger.info(`[RENDERER] unhandled event ${evt.type}`);
                break;
        }
    };

    processFormSubmission = function(evt) {
        logger.info(`[RENDERER] process form submission. ${evt.form.id}`);
        evt.form.data.forEach(ctrl => {
            logger.debug(`${ctrl.key}: ${ctrl.value}`);
            switch (ctrl.name) {
                case 'openDoor':
                    switch(ctrl.value) {
                        case 'openDoor':
                            openDoor();
                            break;
                        case 'endCall':
                            break;
                        default:
                            logger.error(`Unknown value in submitted form: ${ctrl.value}`);
                            return;
                    }
                    app.currentCall && client.leaveConference(app.currentCall.callId);
                    client.updateTextItem({
                        itemId: evt.itemId,
                        content: (ctrl.value === 'openDoor' ? 'Door has been opened' : 'Entrance denied'),
                        form: {
                            id: evt.form.id
                        }
                    });
                    break;
                default:
                    logger.error(`Unknown key in submitted form: ${ctrl.key}`);
                    break;
            }
        });
    };

    /*
     * processItemAddedEvent
     */
    function processItemAddedEvent(evt) {
        if (evt.item.text && evt.item.creatorId !== user.userId) {
            logger.info(`[RENDERER] Received itemAdded event with itemId [${evt.item.itemId}] and content [${evt.item.text.content}]`);
            processCommand(evt.item.convId, evt.item.parentItemId || evt.item.itemId, evt.item.text.content);
        }
    };

    /*
     * processItemUpdatedEvent
     */
    function processItemUpdatedEvent(evt) {
        if (evt.item.text && evt.item.creatorId !== user.userId) {
            if (evt.item.text.content) {
                let lastPart = evt.item.text.content.split('<hr/>').pop();
                logger.info(`[RENDERER] Received itemUpdated event with: ${lastPart}`);
                processCommand(evt.item.convId, evt.item.parentItemId || evt.item.itemId, lastPart);
            }
        }
    };

    /*
     * processCallStatusEvent
     */
    async function processCallStatusEvent(evt) {
        logger.info(`[RENDERER] callStatus event: Reason= ${evt.reason}, State= ${app.currentCall && app.currentCall.state} ==> ${evt.call.state}`);
        logger.info(`[RENDERER] Bot state: ${botState.getStateText()}`);

        if (app.currentCall && app.currentCall.callId !== evt.call.callId) {
            // Event is not for current call
            logger.info('[RENDERER] Received event for a different call');
            return;
        }

        if (!app.currentCall) {
            if (evt.call.state === 'Started') {
                // Conference started. Join.
                let conv = await client.getConversationById(evt.call.convId);
                startConference(conv, evt.call.callId);
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
                        logger.info(`[RENDERER] Check is ${userId} is already in the call`);
                        if (evt.call.participants.indexOf(userId) === -1 && userId !== user.userId) {
                            logger.info(`[RENDERER] Alerting user with userId ${userId}`);
                            client.addParticipantToCall(evt.call.callId, {userId: userId}, true)
                            .then(() => logger.info(`[RENDERER] ${userId} has been alerted that conference is in progress`))
                            .catch(() => logger.error(`[RENDERER] Error adding ${userId} to the conference.`));
                        }
                    });
                });
            }
        } else if (app.currentCall.state !== 'Active' && evt.call.state === 'Active') {
            // At least two participants. Me and someelse. Setup Media.
            setupMedia(evt.call);
            botState.setState(states.INCALL);
        } else {
            logger.info(`[RENDERER] Unhandled call state: ${evt.call.state}`);
        }
        app.currentCall = evt.call;
        // Unsubscribe for motion detection
        gpioHelper.unsubscribeFromMotionDetection(motionDetectorIndex);
        motionDetectorIndex = null;
        if (motionChangeDelayTimer) {
            clearTimeout(motionChangeDelayTimer);
        }
    };

    /*
     * processCallIncomingEvent
     */
    async function processCallIncomingEvent(evt) {
        if (app.currentCall && app.currentCall.callId !== evt.call.callId) {
            // Event is not for current call
            logger.info('[RENDERER] Received event for a different call');
            return;
        }

        if (!app.currentCall) {
            // Incoming call. Answer it.
            let conv = await client.getConversationById(evt.call.convId);
            startConference(conv, evt.call.callId);
        }
        app.currentCall = evt.call;
    };

    /*
     * processCallEndedEvent
     */
    function processCallEndedEvent(evt) {
        if (evt.call.callId === app.currentCall.callId) {
            app.currentCall = null;
            botState.setState(states.IDLE);
            motionDetectorIndex = gpioHelper.subscribeToMotionDetection(motionChange, GpioHelper.MODE_BOTH);
        }
    };

    /*
     * isItForMe?
     */
    function isItForMe(command) {
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
    function processCommand(convId, itemId, command) {
        logger.info(`[RENDERER] Processing command: [${command}]`);
        let withoutName = isItForMe(command);
        if (withoutName) {
            if (monitoringConv.convId !== convId) {
                logger.debug(`[RENDERER] Receive command from convId ${convId} which is not the monitoring conversation. Ignore`);
                return;
            }
            logger.info(`[RENDERER] Command is for me. Processing [${withoutName}]`);
            commander.processCommand(withoutName, async (reply, params) => {
                logger.info(`[RENDERER] Interpreting command to ${reply} with parms ${JSON.stringify(params)}`);
                switch (reply) {
                    case 'status':
                        reportStatus(convId, itemId);
                        break;
                    case 'version':
                        reportVersion(convId, itemId);
                        break;
                    case 'showHelp':
                        showHelp(convId, itemId, params);
                        break;
                    case 'start':
                        let conv = await client.getConversationById(convId);
                        startConference(conv);
                        break;
                    case 'stop':
                        app.currentCall && client.leaveConference(app.currentCall.callId);
                        ipcRenderer.send('relaunch');
                        // ipcRenderer.send('relaunch');
                        // process.exit(1);
                        app.currentCall = null;
                        botState.setState(states.IDLE);
                        break;
                    case 'dial':
                        dial(convId, itemId, params);
                        break;
                    case 'getLogs':
                        getLogFile(convId, itemId);
                        break;
                    case 'search':
                        searchUsers(convId, itemId, params && params[0], true);
                        break;
                    case 'openDoor':
                        openDoor(convId, itemId);
                        break;
                    case 'getTemp':
                        gpioHelper.readTempAndHumidity(function(temp, humidity) {
                            client.addTextItem(convId, buildConversationItem(itemId, null,
                                `Temperature: ${temp}, humidity: ${humidity}`));
                        });
                        break;
                    case 'speechToText':
                        gcsHelper.listen();
                        break;
                    default:
                        logger.info(`[RENDERER] I do not understand [${withoutName}]`);
                        client.addTextItem(convId, buildConversationItem(itemId, null,
                            `I do not understand <b>[${withoutName}]</b>`));
                        break;
                }
            });
        } else {
            logger.info('[RENDERER] Ignoring command: it is not for me');
        }
    };

    /*
     * Gets Log File
     */
    function getLogFile(convId, itemId) {
        fs.readFile(config.logFile, 'utf8', function(err, data) {
            if (err) {
                sendErrorItem(convId, itemId, 'Unable to read log file');
                return;
            }
            let file = new File([data], config.logFile, {type: 'text/plain'});
            client.addTextItem(convId, buildConversationItem(itemId, 'LOGS', 'Here are my logs', file));
        });
        return;
    };

    /*
     * Report bot status
     */
    function reportStatus(convId, itemId) {
        client.addTextItem(convId, buildConversationItem(itemId, null,
            `Status <b>${botState.getStateText()}</b>`));
    };

    /*
     * Report software versions
     */
    function reportVersion(convId, itemId) {
        client.addTextItem(convId, buildConversationItem(itemId, null,
            `App: <b>${packjson.version}</b>, Node: <b>${process.versions.node}</b>, Electron: <b>${process.versions.electron}</b>` +
            `, Chrome: <b>${process.versions.chrome}</b>, v8: <b>${process.versions.v8}</b>`));
    };

    /*
     * Show bot available commands
     */
    function showHelp(convId, itemId, params) {
        logger.info('[RENDERER] Displaying help...');
        commander.buildHelp(params && params.length && params[0]).then((help) =>
            client.addTextItem(convId, buildConversationItem(itemId, 'HELP', help)));
    };

    /*
     * Show an error as a conversation item
     */
    sendErrorItem = function(convId, itemId, err) {
        client.addTextItem(convId, buildConversationItem(itemId, 'ERROR', err));
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
    async function dial(convId, itemId, params) {
        if (!params || !params.length) {
            logger.error(`[RENDERER] No number to dial`);
            sendErrorItem(convId, itemId, 'Unable to dial. Phone number missing');
            return;
        }
        try {
            logger.info(`[RENDERER] Dialling number ${params[0]}`);
            app.currentCall = await client.dialNumber(params[0], null, {audio: true, video: false});
            botState.setState(states.DIALLING);
        } catch (error) {
            sendErrorItem(convId, itemId, `Error dialing number ${params[0]}. Error: ${error}`);
            logger.error(`[RENDERER] Error dialing number ${params[0]}. Error: ${error}`);
        }
    };

    /*
     * Start Circuit Conference
     */
    startConference = async function(conv, callId) {
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
    async function setupMedia(call) {
        if (app.currentCall) {
            let remoteStreams = client.getRemoteStreams(call.callId);
            let remoteAudioStream = remoteStreams.find((s) => s.getAudioTracks().length > 0);
            app.setAudioSource(remoteAudioStream);
            if(call.remoteVideoStreams && call.remoteVideoStreams.length) {
                Vue.nextTick().then(() => {
                    app.setVideoSource(call.remoteVideoStreams[0].stream);
                });
                //document.querySelector('video').srcObject = call.remoteVideoStreams[0].stream;
                //uiElements.videoElement.srcObject = call.remoteVideoStreams[0].stream;
            }
            await sleep(2000);
            sendOpenDoorForm(call.convId);
            //await client.unmute(call.callId);
        }
    };

    /*
     * Search Users
     */
    async function searchUsers(convId, itemId, searchString, test) {
        if (!searchString || !searchString.length) {
            if (test) {
                logger.error(`[RENDERER] Invalid Syntax`);
                sendErrorItem(convId, itemId, 'Invalid syntax. Sintax: search searchString');
            }
            return;
        }
        searchId = client.startUserSearch(searchString);
    };

    /*
     * Process Users Search Results
     */
    async function processSearchResults(data) {
        return new Promise(function(resolve) {
            let users = [];
            searchId = null;
            if (!data || !data.users) {
                logger.info(`[RENDERER] Nothing to do. No search results`);
                resolve(users);
                return;
            }
            data.users.forEach(async function(userId, index) {
                client.getUserById(userId).then((user) => {
                    users.push(user);
                    logger.info(`[RENDERER] User: ${user.firstName} ${user.lastName}`);
                    if (data.users.length === users.length) {
                        resolve(users);
                    }
                });
            });
        });
    };

    function onCallUser(user) {
        logger.info(`[RENDERER] Calling ${user.firstName} ${user.lastName}`);
        if (user.groupConvId) {
            client.getConversationById(user.groupConvId)
                .then(conv => startConference(conv))
                .catch(error => {
                    logger.error(`[RENDERED] Error getting conversation by id. Error: ${error}`);
                });
        } else {
            client.makeCall(user.userId, {audio: true, video: true}, true);
        }
        app.setUsers([]);
        app.resetSearchData();
        gpioHelper.unsubscribeFromMotionDetection(motionDetectorIndex);
        motionDetectorIndex = null;
    }

    function initUI (onCallUserCb, onSearchStringUpdated) {
        app = new Vue({
            el: "#app",
            methods: {
                updateBottomBar: function(temp, humidity) {
                    let date = new Date();
                    this.date = `${date.getMonth()+1}/${date.getDate()}`;
                    this.time = `${date.getHours()}:${date.getMinutes()}`;
                    this.humidity = humidity+'%';
                    this.temp = temp+'°';
                },
                setUsers: function(users) {
                    this.users = users || [];
                    if (this.tooManyUsers()) {
                        this.users = this.users.slice(0, (this.receptionist ? MAX_USERS-1 : MAX_USERS));
                    }
                },
                setCallingUser: function(user) {
                    this.callingUser = user || {}
                },
                callUser: function(userIndex) {
                    this.callingUser = userIndex && this.users[userIndex] || {};
                    this.onCallUserCb(this.callingUser);
                },
                callReceptionist: function() {
                    this.callingUser = this.receptionist;
                    this.onCallUserCb(this.callingUser);
                },
                resetSearchData: function () {
                    this.users = [];
                    this.searchString = '';
                },
                setAudioSource: function (source) {
                    this.audioElement.srcObject = source;
                },
                setVideoSource: function (source) {
                    document.querySelector('video').srcObject = source;
                },
                setPresence: function (status) {
                    this.userPresent = status;
                    if (!status) {
                        this.users = [];
                        this.searchString = '';
                    }
                },
                tapKey: function (key) {
                    this.searchString = this.searchString+key;
                    onSearchStringUpdated(this.searchString);
                },
                tapBskSpc: function () {
                    if (this.searchString.length) {
                        this.searchString = this.searchString.slice(0, this.searchString.length-1);
                        onSearchStringUpdated(this.searchString);
                    }
                },
                tooManyUsers: function () {
                    return this.users.length + (this.receptionist ? 1 : 0) >= 20;
                }
            },
            data: {
                title: config.office && config.office.title || '(Set office.title in config.json)',
                date: '',
                time: '',
                temp: '',
                humidity: '',
                users: [],
                callingUser: {},
                onCallUserCb: onCallUserCb || {},
                searchString: '',
                receptionist: config.receptionist || {},
                audioElement: document.querySelector('audio'),
                userPresent: false,
                currentCall: undefined,
                onSearchStringUpdated: onSearchStringUpdated || {},
            }
        });
        return;
    };

    function onSearchStringUpdated(searchString) {
        if (searchId) {
            client.cancelSearch(searchId);
        }
        searchId = client.startUserSearch(searchString);
        if (motionChangeDelayTimer) {
            clearTimeout(motionChangeDelayTimer);
        }
    }

    function motionChange(status) {
        logger.debug(`[RENDERER] Motion detected status ${status}`);
        if (motionChangeDelayTimer) {
            clearTimeout(motionChangeDelayTimer);
        }
        motionChangeDelayTimer = setTimeout(function () {
            app.setPresence(status === GpioHelper.STATUS_ON);
        }, (status === GpioHelper.STATUS_OFF ? PRESENCE_OFF_DELAY : PRESENCE_ON_DELAY));
    };

    function openDoor(convId, itemId) {
        if (!app.currentCall) {
            let error = 'Attempt to open a door without an active call is not possible';
            logger.warn(`[RENDERER] ${error}`);
            sendErrorItem(convId, itemId, error);
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
                app.updateBottomBar(temp, humidity);
            });
        }
        update();
        setInterval(function () {
            logger.debug('[RENDERER] Update bottom bar');
            update();
        }, interval || UPDATE_HYGROTERMO_INTERVAL);
    };

    async function sendOpenDoorForm(convId) {
        await client.addTextItem(convId, {
            content: 'Select "Open Door" or "I do not know this person"',
            form: {
                id: 'openDoorForm',
                controls: [{
                    type: Circuit.Enums.FormControlType.BUTTON,
                    name: 'openDoor',
                    options: [{
                        text: 'Open Door',
                        notification: 'Opening Door',
                        value: 'openDoor'
                    }, {
                        text: 'I do not know this person',
                        value: 'endCall',
                        notification: 'Access Denied'
                    }]
                }]
            }
        });
    };
};

Circuit.logger.setLevel(Circuit.Enums.LogLevel.Debug);
let bot = new Bot(new Circuit.Client(config.bot));
bot.logonBot()
    .then(bot.updateUserData)
    .then(bot.startSensors)
    .then(bot.sayHi)
    .then(bot.getReceptionConversation)
    .catch(bot.terminate);
