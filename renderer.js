const config = require('./config.json');
const packjson = require('./package.json');
const Commander = require('./commandProcess');
const util = require('util');
const {states, BotState} = require('./botState');
const logger = require('electron-log');
const {ipcRenderer} = require('electron');
const fs = require('fs');
const Circuit = require('circuit-sdk/circuit.js');

// UI States
const SPLASH = 'SPLASH';
const USERS = 'USERS';
const CALL = 'CALL';

// let videoElement;
let audioElement;

let uiData = {
    status: 'SPLASH',
    users: [],
    searchId: null,
    searchString: ''
};

process.argv.forEach(function(argv, index) {
    logger.info(`argv[${index}]: ${argv}`);
});

let Bot = function(client) {
    let self = this;
    let commander = new Commander(logger);
    let botState = new BotState(states.INITIALIZING, logger);
    let currentCall;
    let user;
    let relaunch;

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
        } else {
            logger.info(`[MONAS] Unhandled call state: ${evt.call.state}`);
        }
        currentCall = evt.call;
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
        if (evt.call.callId === currentCall.callId && botState.getState() === states.INCALL) {
            // ipcRenderer.send('relaunch');
            // process.exit(1);
            currentCall = null;
            botState.setState(states.IDLE);
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
                        self.showHelp(convId, itemId);
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
                        self.searchUsers(convId, itemId, params);
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
    this.showHelp = function(convId, itemId) {
        logger.info('[MONAS] Displaying help...');
        commander.buildHelp().then((help) =>
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

            audioElement = document.querySelector('audio');
            let remoteAudioStream = client.getRemoteStreams(call.callId).find((s) => s.getAudioTracks().length > 0);
            audioElement.srcObject = remoteAudioStream;

            // await client.setAudioVideoStream(call.callId, mediaStream);
            await sleep(2000);
            await client.unmute(call.callId);
        }
    };

    /*
     * Search Users
     */
    this.searchUsers = async function(convId, itemId, searchString) {
        if (!searchString || searchString.length !== 1) {
            logger.error(`[MONAS] Invalid Syntax`);
            self.sendErrorItem(convId, itemId, 'Invalid syntax. Sintax: search searchString');
            return;
        }
        uiData.searchId = client.startUserSearch(searchString[0]);
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
    }

    /*
     * Update User Interface
     */
    this.updateUI = function() {
        const MAX_USERS = 4;
        uiData.users = uiData.users || [];
        uiData.users.forEach(function (user, index) {
            if (index < MAX_USERS) {
                let userElement = document.querySelector(`#user_${index}`);
                userElement.style.display = 'inline-block';
                let element = document.querySelector(`#user_name_${index}`);
                element.innerHTML = `${user.firstName} ${user.lastName}`;
                let image = document.querySelector(`#user_image_${index}`);
                image.src = user.avatar;

            }
        });
        if (uiData.users.length < MAX_USERS) {
            for(let i = uiData.users.length; i < MAX_USERS; i++) {
                let userElement = document.querySelector(`#user_${i}`);
                userElement.style.display = 'none';
                //document.querySelector(`#user_${i}`).style.display = 'none';
            }            
        }
    };

};
Circuit.logger.setLevel(Circuit.Enums.LogLevel.Debug);
let bot = new Bot(new Circuit.Client(config.bot));
bot.logonBot()
    .then(bot.updateUserData)
    //.then(bot.sayHi)
    .catch(bot.terminate);

let callUser = bot.callUser;