'use strict'
const record = require('node-record-lpcm16');
const speech = require('@google-cloud/speech');
const extend = require('extend');
const DEFAULT_OPTIONS = {
    encoding: {
      alias: 'e',
      default: 'LINEAR16',
      global: true,
      requiresArg: true,
      type: 'string',
    },
    sampleRateHertz: {
      alias: 'r',
      default: 16000,
      global: true,
      requiresArg: true,
      type: 'number',
    },
    languageCode: {
      alias: 'l',
      default: 'en-US',
      global: true,
      requiresArg: true,
      type: 'string',
    }
};
const DEFAULT_LISTENING_TIME = 5000; // 5 seconds

let gcsHelper = function (logger) {
    let client;

    this.init = function(keyFileName) {
        logger.debug('[GCS] Initializing Speech Client.');
        if (!keyFileName) {
            logger.error('[GCS] Environment is not setup to use Google Cloud Services. Check README.');
            return;
        }
        client = new speech.SpeechClient({
            keyFilename: keyFileName
        });
    };

    this.listen = function(listeningTime, options) {
        return new Promise(function(resolve, reject) {
            if (!client) {
                logger.error('[GCS] Speech Client has not been initialized.');
                reject('Speech Client has not been initialized');
            }
            options = extend(true, options || {}, DEFAULT_OPTIONS);
            listeningTime = listeningTime || DEFAULT_LISTENING_TIME;
            const request = {
                config: {
                  encoding: options.encoding.default,
                  sampleRateHertz: options.sampleRateHertz.default,
                  languageCode: options.languageCode.default,
                  speechContexts: options.speechContexts || []
                },
                interimResults: false, // If you want interim results, set this to true
            };
            
            // Create a recognize stream
            const recognizeStream = client
                .streamingRecognize(request)
                .on('error', function(error) {
                    logger.error(`[GCS] Error transcribing. Error ${error}`);
                    reject(error);
                })
                .on('data', data => {
                    let result = data.results[0] && data.results[0].alternatives[0];
                    if (result) {
                        resolve(result.transcript);
                        return;
                    }
                    reject('Reached transcription time limit');
                });
        
            // Start recording and send the microphone input to the Speech API
            record
                .start({
                    sampleRateHertz: options.sampleRateHertz,
                    threshold: 0,
                    // Other options, see https://www.npmjs.com/package/node-record-lpcm16#options
                    verbose: true,
                    recordProgram: 'arecord', // Try also "rec" or "sox"
                    silence: '10.0',
                })
                .on('error', function(error) {
                    logger.error(`[GCS] Error recording. Error ${error}`);
                    reject(error);
                })
                .pipe(recognizeStream);
            logger.debug(`[GCS] Starting recording for ${listeningTime} seconds`);
            setTimeout(function() {
                logger.debug(`[GCS] Stop recording after ${listeningTime} seconds`);
                record.stop();
            }, listeningTime);
        });
    };
}
module.exports = gcsHelper;