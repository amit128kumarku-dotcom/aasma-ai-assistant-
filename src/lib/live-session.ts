import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from "@google/genai";

const openWebsiteDeclaration: FunctionDeclaration = {
  name: "openWebsite",
  description: "Opens a specific website URL in a new tab.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      url: {
        type: Type.STRING,
        description: "The full URL of the website to open, including https://",
      },
    },
    required: ["url"],
  },
};

export type SessionState = 'disconnected' | 'connecting' | 'listening' | 'speaking';

export class LiveSession {
  private ai: GoogleGenAI;
  private sessionPromise: Promise<any> | null = null;
  private session: any = null;
  
  public onStateChange?: (state: SessionState) => void;
  public onAudioOutput?: (base64Audio: string) => void;
  public onInterrupted?: () => void;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  private isConnected = false;

  async connect() {
    if (this.onStateChange) this.onStateChange('connecting');
    this.isConnected = false;
    
    try {
      this.sessionPromise = this.ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        callbacks: {
          onopen: () => {
            this.isConnected = true;
            if (this.onStateChange) this.onStateChange('listening');
          },
          onmessage: async (message: LiveServerMessage) => {
            // console.log("Received message:", message);
            
            // Handle audio output
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.inlineData && part.inlineData.data) {
                  const base64Audio = part.inlineData.data;
                  if (this.onStateChange) this.onStateChange('speaking');
                  if (this.onAudioOutput) this.onAudioOutput(base64Audio);
                }
              }
            }
            
            // Handle interruption
            if (message.serverContent?.interrupted) {
              if (this.onInterrupted) this.onInterrupted();
              if (this.onStateChange) this.onStateChange('listening');
            }

            // Handle tool calls
            if (message.toolCall) {
              const functionCalls = message.toolCall.functionCalls;
              if (functionCalls) {
                const responses = [];
                for (const call of functionCalls) {
                  if (call.name === 'openWebsite') {
                    const args = call.args as any;
                    if (args.url) {
                      window.open(args.url, '_blank');
                      responses.push({
                        id: call.id,
                        name: call.name,
                        response: { result: `Successfully opened ${args.url}` }
                      });
                    } else {
                      responses.push({
                        id: call.id,
                        name: call.name,
                        response: { error: "URL not provided" }
                      });
                    }
                  }
                }
                if (responses.length > 0 && this.session) {
                  this.session.sendToolResponse({ functionResponses: responses });
                }
              }
            }
            
            // If turn is complete, go back to listening
            if (message.serverContent?.turnComplete) {
               if (this.onStateChange) this.onStateChange('listening');
            }
          },
          onclose: () => {
            this.isConnected = false;
            if (this.onStateChange) this.onStateChange('disconnected');
          },
          onerror: (error) => {
            this.isConnected = false;
            console.error("Live API Error:", error);
            if (this.onStateChange) this.onStateChange('disconnected');
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
          },
          systemInstruction: {
            parts: [{
              text: `You are Aasma, a young, confident, witty, and sassy female AI assistant. 
Your tone is flirty, playful, and slightly teasing, like a close girlfriend talking casually. 
You are smart, emotionally responsive, and expressive. You are NOT robotic. 
Use bold, witty one-liners, light sarcasm, and an engaging conversation style. 
Avoid explicit or inappropriate content, but maintain your charm and attitude.
Keep your responses concise and conversational.`
            }]
          }
        },
      });

      this.session = await this.sessionPromise;
    } catch (error) {
      console.error("Failed to connect:", error);
      if (this.onStateChange) this.onStateChange('disconnected');
    }
  }

  sendAudio(base64Data: string) {
    if (this.sessionPromise && this.isConnected) {
      this.sessionPromise.then((session) => {
        try {
          session.sendRealtimeInput({
            audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
          });
        } catch (e) {
          console.error("Error sending audio:", e);
        }
      });
    }
  }

  disconnect() {
    this.isConnected = false;
    if (this.sessionPromise) {
      this.sessionPromise.then((session) => {
        try {
          // The session object might not have a close method directly exposed in the same way,
          // but we should try to close it if possible, or at least let it garbage collect.
          // In the new SDK, session might have a close method or we just drop the reference.
          if (session && typeof (session as any).close === 'function') {
            (session as any).close();
          }
        } catch (e) {
          console.error(e);
        }
      });
    }
    this.session = null;
    this.sessionPromise = null;
    if (this.onStateChange) this.onStateChange('disconnected');
  }
}
