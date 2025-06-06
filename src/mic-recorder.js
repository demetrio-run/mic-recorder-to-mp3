import Encoder from './encoder';

const inlineProcessor = `
  class RecorderProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.bufferSize = 1152;
      this.buffer = new Float32Array(this.bufferSize);
      this.bytesWritten = 0;
      this.bytesWritten = 0;
      this.port.onmessage = (e) => {
        const data = e.data;
        switch (data.action) {
          case 'stop':
            this._flush();
            break;
        }
      };
    }

    process(inputs) {
      const samples = inputs[0][0];
      if (!samples) {
        return true;
      }
      
      for (let i = 0; i < samples.length; i++) {
        this.buffer[this.bytesWritten++] = samples[i];
        if (this.bytesWritten >= this.bufferSize) {
          this._flush();
        }
      }

      return true;
    }

    _flush() {
      const buffer = this.bytesWritten < this.bufferSize
        ? this.buffer.slice(0, this.bytesWritten)
        : this.buffer;
      
      if (buffer.length) {
        this.port.postMessage({
          action: 'encode',
          buffer
        });
      }

      this.bytesWritten = 0;
    }
  };

  registerProcessor('recorder.processor', RecorderProcessor);
`;

class MicRecorder {
  constructor(config) {
    this.config = {
      // 128 or 160 kbit/s – mid-range bitrate quality
      bitRate: 128,

      deviceId: null,
      // Encode to mp3 after finish recording
      // Encoding during recording may result in distorted audio
      // This could be crucial on mobile devices
      encodeAfterRecord: true,
      // There is a known issue with some macOS machines, where the recording
      // will sometimes have a loud 'pop' or 'pop-click' sound. This flag
      // prevents getting audio from the microphone a few milliseconds after
      // the beginning of the recording. It also helps to remove the mouse
      // 'click' sound from the output mp3 file.
      startRecordingAt: 300,
    };

    Object.assign(this.config, config);

    this.activeStream = null;
    this.context = null;
    this.microphone = null;
    this.processor = null;
    this.rawChunksBuffer = this.config.encodeAfterRecord
      ? []
      : null;

    this.workletUrl = URL.createObjectURL(
      new Blob([inlineProcessor], {
        type: 'application/javascript;charset=utf8',
      })
    );
  }

  createRecorderProcessor() {
    return new Promise((resolve, reject) => {
      try {
        resolve(new AudioWorkletNode(this.context, 'recorder.processor'));
      } catch (error) {
        this.context.audioWorklet
          .addModule(this.workletUrl)
          .then(() =>
            resolve(new AudioWorkletNode(this.context, 'recorder.processor'))
          )
          .catch(reject);
      }
    });
  }

  /**
   * Starts to listen for the microphone sound
   * @param {MediaStream} stream
   */
  addMicrophoneListener(stream) {
    this.activeStream = stream;

    // This prevents the weird noise once you start listening to the microphone
    this.timerToStart = setTimeout(() => {
      delete this.timerToStart;
    }, this.config.startRecordingAt);

    // Set up Web Audio API to process data from the media stream (microphone).
    this.microphone = this.context.createMediaStreamSource(stream);

    return new Promise((resolve, reject) => {
      this.createRecorderProcessor()
        .then((processor) => {
          this.processor = processor;
          this.processor.port.onmessage = (event) => {
            if (event.data.action === 'encode') {
              if (this.timerToStart) {
                return;
              }

              const rawChunk = event.data.buffer;
              if (this.config.encodeAfterRecord) {
                // Save copy of raw chunk for future encoding
                this.rawChunksBuffer.push(Object.assign([], rawChunk));
              } else {
                // Send microphone data to LAME for MP3 encoding while recording.
                this.lameEncoder.encode(rawChunk);
              }
            }
          };

          // Begin retrieving microphone data.
          this.connectMicrophone();

          resolve();
        })
        .catch((e) => reject(e));
    });
  };

  /**
   * Requests access to the microphone and starts recording
   * @return Promise
   */
  initialize() {
    const { deviceId, encodeAfterRecord } = this.config;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContext();
    this.config.sampleRate = this.context.sampleRate;
    this.rawChunksBuffer = encodeAfterRecord ? [] : null;
    this.lameEncoder = new Encoder(this.config);

    const audio = deviceId
      ? { deviceId: { exact: deviceId } }
      : true;

    return new Promise((resolve, reject) => {
      navigator.mediaDevices.getUserMedia({ audio })
        .then(stream => {
          this.addMicrophoneListener(stream);
          resolve(stream);
        })
        .catch(reject);
    });
  };

  /**
   * Initializes or resumes recording
   * @return Promise
   */
  start() {
    if (!this.processor || !this.microphone) {
      return this.initialize();
    } else {
      this.connectMicrophone();
      return Promise.resolve();
    }
  }

  /**
   * Pause recording
   * @return Promise
   */
  pause() {
    this.disconnectMicrophone();
    return Promise.resolve();
  };

  /**
   * Start retrieving microphone data
   */
  connectMicrophone() {
    if (this.processor && this.microphone) {
      this.microphone.connect(this.processor);
      this.processor.connect(this.context.destination);
    }
  }

  /**
   * Stop retrieving microphone data
   */
  disconnectMicrophone() {
    if (this.processor && this.microphone) {
      this.processor.port.postMessage({ action: 'stop' });
      this.microphone.disconnect();
      this.processor.disconnect();
    }
  }

  /**
   * Disconnect microphone, processor and remove activeStream
   * @return MicRecorder
   */
  stop() {
    if (this.processor && this.microphone) {
      // Clean up the Web Audio API resources.
      this.disconnectMicrophone();

      // If all references using this.context are destroyed, context is closed
      // automatically. DOMException is fired when trying to close again
      if (this.context && this.context.state !== 'closed') {
        this.context.close();
      }

      // Stop all audio tracks. Also, removes recording icon from chrome tab
      this.activeStream.getAudioTracks().forEach(track => track.stop());
      this.processor = null;
      this.microphone = null;
    }

    return this;
  };

  /**
   * Return Mp3 Buffer and Blob with type mp3
   * @return Promise
   */
  getMp3() {
    if (this.config.encodeAfterRecord) {
      this.rawChunksBuffer.forEach((rawChunk) => {
        this.lameEncoder.encode(rawChunk);
      });

      this.rawChunksBuffer = [];
    }

    const finalBuffer = this.lameEncoder.finish();

    return new Promise((resolve, reject) => {
      if (finalBuffer.length === 0) {
        reject(new Error('No buffer to send'));
      } else {
        resolve([finalBuffer, new Blob(finalBuffer, { type: 'audio/mp3' })]);
        this.lameEncoder.clearBuffer();
      }
    });
  };
}

export default MicRecorder;
