'use strict';
let Gpio = require('onoff').Gpio; //include onoff to interact with the GPIO
//GPIO Definitions
let GPIO_PIN_25 = 25; // Motion Sensor
let GPIO_PIN_16 = 16; // LED
let GPIO_PIN_12 = 12; // Buzzer

let STATUS_OFF = 0;
let STATUS_ON = 1;

//Motion detection modes
const MODE_ON_ONLY= 'MODE_ON_ONLY';
const MODE_OFF_ONLY = 'MODE_OFF_ONLY';
const MODE_BOTH = 'MODE_BOTH';
const SENSOR_QUERY_INTERVAL = 100; // 1 sec


let GpioHelper = function (logger) {
    let motionSensor;
    let LED;
    let buzzer;
    let motionDetectionSubscribers = [];
    let motionSensorTimer;
    let currentDetectionStatus = null;
    let self = this;

    this.initMotionSensor = function(gpioPin) {
       motionSensor = new Gpio(gpioPin || GPIO_PIN_25, 'in', 'both');
    };

    this.initLED = function(gpioPin) {
        LED = new Gpio(gpioPin || GPIO_PIN_16, 'out');
    };

    this.setLED = function(status) {
        LED.writeSync(status);
    };

    this.initBuzzer = function(gpioPin) {
        buzzer = new Gpio(gpioPin || GPIO_PIN_12, 'out');
    };

    this.setBuzzer = function(status) {
        buzzer.writeSync(status);
    };

    this.subscribeToMotionDetection = function (callbak, mode) {
        logger.debug('[GPIO] New Subscription to motion detection');
        if (callbak) {
            motionDetectionSubscribers.push({
                callback: callbak,
                mode: mode
            });
            if (!motionSensorTimer) {
                logger.debug(`[GPIO]: Starting Motion Detection Interval`);
                motionSensorTimer = setInterval(function () {
                    motionSensor.read(function(error, status) {
                        //logger.debug(`[GPIO]: Checking Motion Detection: Error ${error} Status ${status}`);
                        if (!error) {
                            if (currentDetectionStatus === null || currentDetectionStatus !== status) {
                                logger.debug('[GPIO]: Start notifying sbscribers');
                                notifySubscribersOfMotionDetection(status);
                            }
                            currentDetectionStatus = status;
                            return;
                        }
                        logger(`[GPIO] Error querying sensor: Error ${error}`);
                    });
                }, SENSOR_QUERY_INTERVAL);
            }
            return motionDetectionSubscribers.length - 1;
        }
        logger.error('[GPIO] No callback provided');
    };

    this.unsubscribeFromMotionDetection = function (index) {
        if (index >= 0 && index < motionDetectionSubscribers.length) {
            motionDetectionSubscribers.splice(index, 1);
        }
        if (!motionDetectionSubscribers.length) {
            clearInterval(motionSensorTimer);
            motionSensorTimer = null;
        }
    };

    this.getCurrentMotionSensorStatus = function () {
        if (!motionSensor) {
            logger.error('[GPIO] Motion sensor has not be initialized yet');
            return;
        }
        return motionSensor.readSync();
    };

    function notifySubscribersOfMotionDetection(status) {
        logger.debug(`[GPIO] Notifying ${motionDetectionSubscribers.length} subscribers for status ${status}`);
        motionDetectionSubscribers.forEach(function(subs, index) {
            if (status === STATUS_ON) {
                if (subs.mode !== MODE_OFF_ONLY) {
                    logger.debug(`[GPIO] Notifying for mode ${subs.mode} to subscriber #${index}`);
                    subs.callback(status);
                } 
            } else {
                if (subs.mode !== MODE_ON_ONLY) {
                    logger.debug(`[GPIO] Notifying for mode ${subs.mode} to subscriber #${index}`);
                    subs.callback(status);
                }
            }
        })
    }
};
module.exports = GpioHelper;
module.exports.MODE_BOTH = MODE_BOTH;
module.exports.MODE_ON_ONLY = MODE_ON_ONLY;
module.exports.MODE_OFF_ONLY = MODE_OFF_ONLY;
module.exports.STATUS_OFF = STATUS_OFF;
module.exports.STATUS_ON = STATUS_ON;