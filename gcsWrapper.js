'use strict'
const record = require('node-record-lpcm16');
const speech = require('@google-cloud/speech');
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
        if (!client) {
            logger.error('[GCS] Speech Client has not been initialized.');
            return;
        }
        options = options || DEFAULT_OPTIONS;
        listeningTime = listeningTime || DEFAULT_LISTENING_TIME;
        const request = {
            config: {
              encoding: options.encoding,
              sampleRateHertz: options.sampleRateHertz,
              languageCode: options.languageCode,
            },
            interimResults: false, // If you want interim results, set this to true
        };
        
        // Create a recognize stream
        const recognizeStream = client
            .streamingRecognize(request)
            .on('error', function(error) {
                logger.error(`[GCS] Error transcribing. Error ${error}`);
            })
            .on('data', data =>
                logger.debug(
                data.results[0] && data.results[0].alternatives[0]
                    ? `Transcription: ${data.results[0].alternatives[0].transcript}\n`
                    : `\n\nReached transcription time limit, press Ctrl+C\n`
                )
            );
    
        // Start recording and send the microphone input to the Speech API
        record
            .start({
                sampleRateHertz: options.sampleRateHertz,
                threshold: 0,
                // Other options, see https://www.npmjs.com/package/node-record-lpcm16#options
                verbose: false,
                recordProgram: 'sox', // Try also "arecord" or "sox"
                silence: '10.0',
            })
            .on('error', function(error) {
                logger.error(`[GCS] Error recording. Error ${error}`);
            })
            .pipe(recognizeStream);
        logger.debug(`[GCS] Starting recording for ${listeningTime} seconds`);
        setTimeout(function() {
            logger.debug(`[GCS] Stop recording after ${listeningTime} seconds`);
            record.stop();
        }, listeningTime);
    };
}
module.exports = gcsHelper;