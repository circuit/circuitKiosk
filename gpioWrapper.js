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
const SENSOR_QUERY_INTERVAL = 100; // .1 sec

// LED Flashing on and off default times
const LED_FLASH_SPEED_DEFAULT_TIME = 500; // 500 ms


let GpioHelper = function (logger, mock) {
    let motionSensor;
    let LED;
    let buzzer;
    let motionDetectionSubscribers = [];
    let motionSensorTimer;
    let currentDetectionStatus = null;
    let ledFlashingTimer;

    if (mock) {
        logger.debug('[GPIO] It seems we are not running on an actual RPI. Mocking of GPIO shall start');
        gpioMock.start(function () {
            logger.debug('[GPIO] GPIO Mocking Started');
        });
    }

    this.initMotionSensor = function(gpioPin) {
       motionSensor = new Gpio(gpioPin || GPIO_PIN_25, 'in', 'both');
    };

    this.initLED = function(gpioPin) {
        LED = new Gpio(gpioPin || GPIO_PIN_16, 'out');
    };

    this.setLED = function(status) {
        if (ledFlashingTimer) {
            clearInterval(ledFlashingTimer);
            ledFlashingTimer = null;
        }
        LED.writeSync(status);
    };

    this.flashLed = function(speed) {
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
                logger.debug(`[GPIO] Starting Motion Detection Interval`);
                motionSensorTimer = setInterval(function () {
                    motionSensor.read(function(error, status) {
                        if (!error) {
                            if (currentDetectionStatus === null || currentDetectionStatus !== status) {
                                logger.debug('[GPIO] Start notifying sbscribers');
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

    this.readTempAndHumidity = function (cb, gpioPin, dhtType) {
        cb = cb || {};
        if (mock) {
            cb(25,45);
            return;
        }
        DHTSensor.read(dhtType || HYGRO_THERMO_GRAPH_SENSOR_TYPE_DHT11, gpioPin || GPIO_PIN_21, function(err, temp, humidity) {
            if(!err) {
                console.log(`Temperature: ${temp.toFixed(1)} °C. Humidity: ${humidity.toFixed(1)} %`);
                cb(temp, humidity);
            } else {
                console.log(`Error reading DHT11. Error: ${err}`);
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
    };
};
module.exports = GpioHelper;
module.exports.MODE_BOTH = MODE_BOTH;
module.exports.MODE_ON_ONLY = MODE_ON_ONLY;
module.exports.MODE_OFF_ONLY = MODE_OFF_ONLY;
module.exports.STATUS_OFF = STATUS_OFF;
module.exports.STATUS_ON = STATUS_ON;