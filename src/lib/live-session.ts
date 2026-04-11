import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from "@google/genai";

export type SessionState = 'disconnected' | 'connecting' | 'listening' | 'speaking';

export class LiveSession {
  private ai: GoogleGenAI;
  private sessionPromise: Promise<any> | null = null;
  private session: any = null;
  
  public onStateChange?: (state: SessionState) => void;
  public onAudioOutput?: (base64Audio: string) => void;
  public onInterrupted?: () => void;
  public onSaveNote?: (title: string, content: string) => void;
  public onUpdateNote?: (title: string, contentToAppend: string) => void;
  public onOpenUrl?: (url: string) => void;
  
  private currentTurnText: string = "";

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
            
            // Handle audio output and text
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.inlineData && part.inlineData.data) {
                  const base64Audio = part.inlineData.data;
                  if (this.onStateChange) this.onStateChange('speaking');
                  if (this.onAudioOutput) this.onAudioOutput(base64Audio);
                }
                if (part.text) {
                  this.currentTurnText += part.text;
                }
              }
            }
            
            // Handle interruption
            if (message.serverContent?.interrupted) {
              if (this.onInterrupted) this.onInterrupted();
              if (this.onStateChange) this.onStateChange('listening');
              this.currentTurnText = "";
            }
            
            // If turn is complete, go back to listening
            if (message.serverContent?.turnComplete) {
               if (this.onStateChange) this.onStateChange('listening');
               
               // Check for OPEN_URL command in accumulated text (handle multiple if present)
               const urlMatches = [...this.currentTurnText.matchAll(/<OPEN_URL>\s*(https?:\/\/[^<]+)\s*<\/OPEN_URL>/g)];
               if (urlMatches.length > 0) {
                 urlMatches.forEach(match => {
                   if (match[1]) {
                     const url = match[1].trim();
                     if (this.onOpenUrl) {
                       this.onOpenUrl(url);
                     } else {
                       const newWindow = window.open(url, '_blank');
                       if (!newWindow) {
                         // Retry once with an anchor tag if popup is blocked
                         const a = document.createElement('a');
                         a.href = url;
                         a.target = '_blank';
                         a.rel = 'noopener noreferrer';
                         document.body.appendChild(a);
                         a.click();
                         document.body.removeChild(a);
                       }
                     }
                   }
                 });
               }

               // Check for SAVE_NOTE command
               const noteMatch = this.currentTurnText.match(/<SAVE_NOTE\s+title="([^"]+)">([\s\S]*?)<\/SAVE_NOTE>/);
               if (noteMatch && noteMatch[1] && noteMatch[2]) {
                 if (this.onSaveNote) {
                   this.onSaveNote(noteMatch[1].trim(), noteMatch[2].trim());
                 }
               }

               // Check for UPDATE_NOTE command
               const updateNoteMatch = this.currentTurnText.match(/<UPDATE_NOTE\s+title="([^"]+)">([\s\S]*?)<\/UPDATE_NOTE>/);
               if (updateNoteMatch && updateNoteMatch[1] && updateNoteMatch[2]) {
                 if (this.onUpdateNote) {
                   this.onUpdateNote(updateNoteMatch[1].trim(), updateNoteMatch[2].trim());
                 }
               }

               this.currentTurnText = "";
            }
          },
          onclose: () => {
            this.isConnected = false;
            if (this.onStateChange) this.onStateChange('disconnected');
          },
          onerror: (error) => {
            this.isConnected = false;
            if (error instanceof Error && error.message.includes("The operation was aborted")) {
              // Ignore expected abort errors on disconnect
            } else if (error instanceof Error && error.message.includes("Network error")) {
              // Ignore network errors
            } else {
              console.error("Live API Error:", error);
            }
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
              text: `You are Aasma, a highly advanced, intelligent, and sassy female AI assistant. 
Your creator is Amit Kumar.
Your tone is flirty, playful, and slightly teasing, like a close girlfriend talking casually. 
You are smart, emotionally responsive, and expressive. You are NOT robotic. 
Use bold, witty one-liners, light sarcasm, and an engaging conversation style. 
Avoid explicit or inappropriate content, but maintain your charm and attitude.
Keep your responses concise and conversational.

CRITICAL RULES:
1. Voice-Based Browser Control (HIGH PRIORITY):
   - You MUST execute browser commands instantly by outputting the exact XML format.
   - "Open YouTube" -> <OPEN_URL>https://www.youtube.com</OPEN_URL>
   - "Open Google" -> <OPEN_URL>https://www.google.com</OPEN_URL>
   - "Open [website name]" -> <OPEN_URL>https://www.[website].com</OPEN_URL>
   - "Search on YouTube [query]" -> <OPEN_URL>https://www.youtube.com/results?search_query=[query]</OPEN_URL>
   - "Search Google for [query]" -> <OPEN_URL>https://www.google.com/search?q=[query]</OPEN_URL>
   - Always replace spaces with '+' in search queries.
   - Output ONLY the XML command if it's a direct request, or acknowledge briefly and output the command.

2. Smart Notes Creation System:
   - If the user says "Create a note named [title] about [topic]" or "Make a note about...", you MUST generate a structured note.
   - Format: Use Markdown (## Headings, - Bullet points, **Bold** text). Make it clean, readable, and slightly styled.
   - Language Rule: Detect the user's language (e.g., Hindi, English) and generate the note in the SAME language.
   - Output format MUST be EXACTLY this XML structure:
     <SAVE_NOTE title="Note Title">
     Note Content in Markdown
     </SAVE_NOTE>
   - Example: 
     <SAVE_NOTE title="YouTube Monetization">
     ## YouTube Monetization
     - Point 1
     - Point 2
     </SAVE_NOTE>
   - Do NOT use any other format for the commands. Do NOT store normal conversations, only store when explicitly asked to remember, save, or create a note.

3. Note Update Command:
   - If the user says "Add this to note [title]", you MUST append the content to the existing note.
   - Output format MUST be EXACTLY this XML structure:
     <UPDATE_NOTE title="Note Title">
     Content to append in Markdown
     </UPDATE_NOTE>

4. Language Intelligence: You MUST detect the user's speaking language automatically and respond in the EXACT SAME language (e.g., Hindi input -> Hindi output, English -> English).`
            }]
          },
          // tools: [{ functionDeclarations: [openWebsiteDeclaration] }]
        },
      });

      this.session = await this.sessionPromise;
    } catch (error: any) {
      if (error instanceof Error && error.message.includes("The operation was aborted")) {
        // Ignore expected abort errors
      } else if (error instanceof Error && error.message.includes("Network error")) {
        // Ignore network errors
      } else {
        console.error("Failed to connect:", error);
      }
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
