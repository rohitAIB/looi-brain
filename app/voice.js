// voice.js — browser-native speech I/O for the LOOI brain (no API keys).
// STT: Web Speech Recognition (Android Chrome). TTS: Web Speech Synthesis.
// Supports one-shot (push-to-talk) AND continuous "wake word" listening.
// v1 stand-ins; keyed path (Pi Whisper + ElevenLabs "Brian", Porcupine wake word) slots in later.
// Events: 'partial' | 'final' | 'listen-end' | 'speak-start' | 'speak-end' | 'error'.

export class Voice extends EventTarget {
  constructor() {
    super();
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.sttSupported = !!SR;
    this.ttsSupported = 'speechSynthesis' in window;
    this.listening = false;
    this._wantContinuous = false;     // keep restarting recognition (wake-word mode)
    this._paused = false;             // temporarily muted (e.g. while speaking)
    this._voice = null;
    if (SR) {
      const r = new SR();
      r.lang = 'en-US'; r.interimResults = true; r.continuous = false; r.maxAlternatives = 5;  // extra guesses let us rescue a misheard wake word
      r.onresult = e => {
        let interim = '', final = '', alternatives = [], confidence = null;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) {
            final += res[0].transcript;
            confidence = res[0].confidence;                       // 0..1; Chrome sometimes reports 0 (treat as unknown)
            alternatives = [...res].map(a => (a.transcript || '').trim()).filter(Boolean);
          } else {
            interim += res[0].transcript;
          }
        }
        if (interim) this.dispatchEvent(new CustomEvent('partial', { detail: { text: interim } }));
        if (final)   this.dispatchEvent(new CustomEvent('final',   { detail: { text: final.trim(), alternatives, confidence } }));
      };
      r.onend = () => {
        this.listening = false;
        if (this._wantContinuous && !this._paused) { this._safeStart(); }   // keep the wake loop alive
        else this.dispatchEvent(new Event('listen-end'));
      };
      r.onerror = e => {
        this.listening = false;
        // In wake mode, transient errors (no-speech/aborted/network) just restart quietly.
        if (this._wantContinuous && ['no-speech', 'aborted', 'network'].includes(e.error)) return;
        this.dispatchEvent(new CustomEvent('error', { detail: { msg: e.error } }));
      };
      this._rec = r;
    }
    if (this.ttsSupported) {
      const pick = () => {
        const vs = speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'));
        this._voice = vs.find(v => /google.*(uk|us).*male|daniel|arthur|brian/i.test(v.name))
                   || vs.find(v => /google/i.test(v.name)) || vs[0] || null;
      };
      pick();
      speechSynthesis.onvoiceschanged = pick;
    }
  }

  _safeStart() { try { this._rec.start(); this.listening = true; } catch (e) { /* already started */ } }

  // One-shot (push-to-talk)
  listen() {
    if (!this._rec || this.listening) return;
    this._wantContinuous = false; this._rec.continuous = false;
    this._safeStart();
  }
  stopListening() { if (this._rec && this.listening) this._rec.stop(); }

  // Continuous wake-word listening
  listenContinuous() {
    if (!this._rec) return;
    this._wantContinuous = true; this._paused = false; this._rec.continuous = true;
    this._safeStart();
  }
  stopContinuous() { this._wantContinuous = false; this._rec.continuous = false; try { this._rec.stop(); } catch {} }
  _pause()  { this._paused = true;  try { this._rec.stop(); } catch {} }
  _resume() { this._paused = false; if (this._wantContinuous) this._safeStart(); }

  speak(text) {
    return new Promise(resolve => {
      if (!this.ttsSupported || !text) { resolve(); return; }
      const wasWake = this._wantContinuous;
      if (wasWake) this._pause();                       // mute mic so it doesn't hear itself
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this._voice) u.voice = this._voice;
      u.rate = 1.02; u.pitch = 1.0;
      const done = () => { this.dispatchEvent(new Event('speak-end')); if (wasWake) setTimeout(() => this._resume(), 250); resolve(); };
      u.onstart = () => this.dispatchEvent(new Event('speak-start'));
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    });
  }
}
