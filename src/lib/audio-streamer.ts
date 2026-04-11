export class AudioStreamer {
  private recordingContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private recordingWorkletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  public onAudioData?: (base64Data: string) => void;
  public onVolumeChange?: (volume: number) => void;

  async startRecording() {
    // Initialize playback context during user gesture to prevent autoplay blocking
    if (!this.playbackContext) {
      this.initPlayback();
    }

    this.recordingContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    } });
    this.source = this.recordingContext.createMediaStreamSource(this.mediaStream);
    
    if (this.recordingContext.state === 'suspended') {
      this.recordingContext.resume();
    }
    
    const workletCode = `
      class RecorderProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.bufferSize = 2048;
          this.buffer = new Float32Array(this.bufferSize);
          this.bytesWritten = 0;
        }

        process(inputs, outputs, parameters) {
          const input = inputs[0];
          if (input.length > 0) {
            const channelData = input[0];
            for (let i = 0; i < channelData.length; i++) {
              this.buffer[this.bytesWritten++] = channelData[i];
              if (this.bytesWritten >= this.bufferSize) {
                this.port.postMessage(this.buffer);
                this.buffer = new Float32Array(this.bufferSize);
                this.bytesWritten = 0;
              }
            }
          }
          return true;
        }
      }
      registerProcessor('recorder-processor', RecorderProcessor);
    `;

    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    try {
      await this.recordingContext.audioWorklet.addModule(url);
      if (!this.recordingContext) return;
      this.recordingWorkletNode = new AudioWorkletNode(this.recordingContext, 'recorder-processor');
      
      this.recordingWorkletNode.port.onmessage = (e) => {
        const inputData = e.data as Float32Array;
        
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);
        if (this.onVolumeChange) {
          this.onVolumeChange(rms);
        }

        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          let s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        const buffer = new ArrayBuffer(pcm16.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < pcm16.length; i++) {
          view.setInt16(i * 2, pcm16[i], true);
        }
        
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        
        if (this.onAudioData) {
          this.onAudioData(base64);
        }
      };

      this.source.connect(this.recordingWorkletNode);
      this.recordingWorkletNode.connect(this.recordingContext.destination);
    } catch (err) {
      console.error("Failed to load recorder worklet:", err);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  stopRecording() {
    if (this.recordingWorkletNode && this.source) {
      this.source.disconnect();
      this.recordingWorkletNode.disconnect();
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
    }
    if (this.recordingContext) {
      this.recordingContext.close();
    }
    this.recordingContext = null;
    this.mediaStream = null;
    this.recordingWorkletNode = null;
    this.source = null;
  }

  private playbackContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private isWorkletReady = false;
  private pendingChunks: Float32Array[] = [];

  async initPlayback() {
    if (this.playbackContext) return;
    
    this.playbackContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    
    // Resume immediately if suspended (since we are in a user gesture)
    if (this.playbackContext.state === 'suspended') {
      this.playbackContext.resume();
    }
    
    const workletCode = `
      class PCMProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.queue = [];
          this.port.onmessage = (e) => {
            if (e.data === 'clear') {
              this.queue = [];
              return;
            }
            this.queue.push(e.data);
          };
        }

        process(inputs, outputs, parameters) {
          const output = outputs[0];
          const channelCount = output.length;
          let outputIndex = 0;

          // We only need to process the logic once for the first channel,
          // then copy the result to the other channels.
          const firstChannel = output[0];

          while (outputIndex < firstChannel.length && this.queue.length > 0) {
            const currentChunk = this.queue[0];
            const spaceLeft = firstChannel.length - outputIndex;
            
            if (currentChunk.length <= spaceLeft) {
              firstChannel.set(currentChunk, outputIndex);
              outputIndex += currentChunk.length;
              this.queue.shift();
            } else {
              firstChannel.set(currentChunk.subarray(0, spaceLeft), outputIndex);
              this.queue[0] = currentChunk.subarray(spaceLeft);
              outputIndex += spaceLeft;
            }
          }

          for (let i = outputIndex; i < firstChannel.length; i++) {
            firstChannel[i] = 0;
          }

          // Copy to other channels
          for (let c = 1; c < channelCount; c++) {
            output[c].set(firstChannel);
          }

          return true;
        }
      }
      registerProcessor('pcm-processor', PCMProcessor);
    `;
    
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    
    try {
      await this.playbackContext.audioWorklet.addModule(url);
      if (!this.playbackContext) return;
      this.workletNode = new AudioWorkletNode(this.playbackContext, 'pcm-processor');
      this.workletNode.connect(this.playbackContext.destination);
      this.isWorkletReady = true;
      
      while (this.pendingChunks.length > 0) {
        const chunk = this.pendingChunks.shift();
        if (chunk) {
          this.workletNode.port.postMessage(chunk);
        }
      }
    } catch (error) {
      console.error("Failed to load audio worklet:", error);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  playAudioChunk(base64Data: string) {
    if (!this.playbackContext) {
      this.initPlayback();
    }
    
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768.0;
    }
    
    if (this.isWorkletReady && this.workletNode) {
      if (this.playbackContext?.state === 'suspended') {
        this.playbackContext.resume();
      }
      this.workletNode.port.postMessage(float32);
    } else {
      this.pendingChunks.push(float32);
    }
  }

  stopPlayback() {
    this.pendingChunks = [];
    if (this.workletNode) {
      this.workletNode.port.postMessage('clear');
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.playbackContext) {
      this.playbackContext.close();
      this.playbackContext = null;
    }
    this.isWorkletReady = false;
  }
}
