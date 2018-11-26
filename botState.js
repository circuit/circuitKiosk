'use strict';

// TODO: Needs localization
let states = {
    INITIALIZING: {
        defaultText: 'Initializing',
    },
    IDLE: {
        defaultText: 'Idle',
    },
    INCALL: {
        defaultText: 'In a call',
    },
    STARTCONF: {
        defaultText: 'Starting Conference',
    },
    ALERTING: {
        defaultText: 'Alerting participants',
    },
    DIALLING: {
        defaultText: 'Dialling',
    },
};

module.exports.states = states;

let BotState = function(st, log) {
    let logger = log;
    if (!st) {
        logger.error(`[STATES] Invalid bot state. State= ${st}. Forcing to INITIALIZING`);
        st = states.INITIALIZING;
    }
    let state = st;

    logger.info(`[STATES] Initializing state with state: ${st.defaultText}`);

    this.setState = function(st) {
        if (!st) {
            logger.error('[STATES] Invalid bot state.');
            return;
        }
        logger.info(`[STATES] New state: ${st.defaultText}`);
        state = st;
    };

    this.getState = function() {
        logger.info(`[STATES] State: ${state.defaultText}`);
        return state;
    };

    this.getStateText = function() {
        return state.defaultText;
    };
};

module.exports.BotState = BotState;
