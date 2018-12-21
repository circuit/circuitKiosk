'use strict';
let Gpio = require('onoff').Gpio; //include onoff to interact with the GPIO
let gpioMock = require('gpio-mock');
let DHTSensor = require("node-dht-sensor");

//GPIO Definitions
let GPIO_PIN_25 = 25; // Motion Sensor
let GPIO_PIN_16 = 16; // LED
let GPIO_PIN_12 = 12; // Buzzer
let GPIO_PIN_21 = 21; // Hygrothermograph Sensor

let STATUS_OFF = 0;
let STATUS_ON = 1;

let HYGRO_THERMO_GRAPH_SENSOR_TYPE_DHT11 = 11;

// Motion detection modes
const MODE_ON_ONLY= 'MODE_ON_ONLY';
const MODE_OFF_ONLY = 'MODE_OFF_ONLY';
const MODE_BOTH = 'MODE_BOTH';
const SENSOR_QUERY_INTERVAL = 1000; // .1 sec
// Presence detection time to switch to user search screen
const DEFAULT_PRESENCE_ON_DELAY = 1000; // 1 second
// Time to switch back to splash screen after no more presence
const DEFAULT_PRESENCE_OFF_DELAY = 10000; // 10 seconds
// Time before starting motion after initialization
const DEFAULT_INITIAL_MOTION_DETECTION_DELAY = 0;

// LED Flashing on and off default times
const LED_FLASH_SPEED_DEFAULT_TIME = 500; // 500 ms


let GpioHelper = function (logger, mock) {
    let motionSensor;
    let LED;
    let buzzer;
    let motionSensorTimer;
    let presenceNotificationDelayTimer;
    let currentDetectionStatus = null;
    let ledFlashingTimer;
    let motionSensorOptions;
    let self = this;

    if (mock) {
        logger.debug('[GPIO] It seems we are not running on an actual RPI. Mocking of GPIO shall start');
        gpioMock.start(function () {
            logger.debug('[GPIO] GPIO Mocking Started');
        });
    }

    this.initMotionSensor = function(gpioPin) {
       motionSensor = new Gpio(gpioPin || GPIO_PIN_25, 'in', 'both');
    };

    this.initPresenceChangeSensor = function(options) {
        if (!options || !options.callback) {
            logger.error('[GPIO] Not enough options to initialize motion sensor');
            return;
        }
        motionSensorOptions = options;
        motionSensor = new Gpio(motionSensorOptions.gpioPin || GPIO_PIN_25, 'in', 'both');
        if(options.detection === STATUS_ON) {
            setTimeout(() => self.restartPresenceDetection(motionSensorOptions),
            options.initialDelay || DEFAULT_INITIAL_MOTION_DETECTION_DELAY);
        }
    };

    this.restartPresenceDetection = function(options) {
        logger.debug('[GPIO] Restart Precense Detection');
        options = options || motionSensorOptions;
        if (!options.callback) {
            logger.error('[GPIO] Not enough options to initialize motion sensor');
            return;
        }
        if (motionSensorTimer) {
            clearInterval(motionSensorTimer);
        }
        motionSensorTimer = setInterval(() => {
            motionSensor.read((error, status) => {
                if (!error) {
                    if (currentDetectionStatus === null || currentDetectionStatus !== status) {
                        logger.debug(`[GPIO] Status change. Old status = ${currentDetectionStatus}. New status ${status}.`);
                        if (presenceNotificationDelayTimer) {
                            clearTimeout(presenceNotificationDelayTimer);
                        }
                        presenceNotificationDelayTimer = setTimeout(() => {
                            logger.debug(`[GPIO] Invoke callback with status ${status}`);
                            options.callback(status);
                        }, status === STATUS_OFF ? motionSensorOptions.presenceOffDelay || DEFAULT_PRESENCE_OFF_DELAY
                            : motionSensorOptions.presenceOnDelay || DEFAULT_PRESENCE_ON_DELAY);
                    }
                    currentDetectionStatus = status;
                    return;
                }
                logger(`[GPIO] Error querying sensor: Error ${error}`);
            });
        }, options.presenceCheckTime || SENSOR_QUERY_INTERVAL);
    };

    this.stopPresenceDetection = function() {
        logger.debug('[GPIO] Stop Precense Detection');
        if(motionSensorTimer) {
            clearInterval(motionSensorTimer);
            motionSensorTimer = null;
        }
    };

    this.initLED = function(gpioPin, status) {
        LED = new Gpio(gpioPin || GPIO_PIN_16, 'out');
        self.setLED(status);
    };

    this.setLED = function(status) {
        if (ledFlashingTimer) {
            clearInterval(ledFlashingTimer);
            ledFlashingTimer = null;
        }
        LED.writeSync(status);
    };

    this.flashLED = function(speed) {
        speed = speed || LED_FLASH_SPEED_DEFAULT_TIME;
        let status = STATUS_ON;
        LED.writeSync(status);
        if (ledFlashingTimer) {
            clearInterval(ledFlashingTimer);
        }
        ledFlashingTimer = setInterval(() => {
            status = status === STATUS_ON ? STATUS_OFF : STATUS_ON;
            LED.writeSync(status);
        }, speed);
    };

    this.initBuzzer = function(gpioPin, status) {
        buzzer = new Gpio(gpioPin || GPIO_PIN_12, 'out');
        self.setBuzzer(status);
    };

    this.setBuzzer = function(status) {
        buzzer.writeSync(status);
    };

    this.readTempAndHumidity = function (cb, gpioPin, dhtType) {
        cb = cb || {};
        if (mock) {
            cb(25,45);
            return;
        }
        DHTSensor.read(dhtType || HYGRO_THERMO_GRAPH_SENSOR_TYPE_DHT11, gpioPin || GPIO_PIN_21, function(err, temp, humidity) {
            if(!err) {
                logger.debug(`Temperature: ${temp.toFixed(1)} °C. Humidity: ${humidity.toFixed(1)} %`);
                cb(temp, humidity);
            } else {
                logger.error(`Error reading DHT11. Error: ${err}`);
            }
        });
    };

    this.getCurrentMotionSensorStatus = function () {
        if (!motionSensor) {
            logger.error('[GPIO] Motion sensor has not be initialized yet');
            return;
        }
        return motionSensor.readSync();
    };

};
module.exports = GpioHelper;
module.exports.MODE_BOTH = MODE_BOTH;
module.exports.MODE_ON_ONLY = MODE_ON_ONLY;
module.exports.MODE_OFF_ONLY = MODE_OFF_ONLY;
module.exports.STATUS_OFF = STATUS_OFF;
module.exports.STATUS_ON = STATUS_ON;