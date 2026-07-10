// voice.js — browser-native speech I/O for the LOOI brain (no API keys).
// STT: Web Speech Recognition (Android Chrome). TTS: Web Speech Synthesis.
// These are the v1 stand-ins; the keyed path (Pi Whisper + ElevenLabs "Brian") slots in later
// behind the same interface. Events: 'partial' | 'final' | 'listen-end' | 'speak-start' | 'speak-end' | 'error'.

export class Voice extends EventTarget {
  constructor() {
    super();
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.sttSupported = !!SR;
    this.ttsSupported = 'speechSynthesis' in window;
    this.listening = false;
    this._voice = null;
    if (SR) {
      const r = new SR();
      r.lang = 'en-US'; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
      r.onresult = e => {
        let interim = '', final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) final += t; else interim += t;
        }
        if (interim) this.dispatchEvent(new CustomEvent('partial', { detail: { text: interim } }));
        if (final)   this.dispatchEvent(new CustomEvent('final',   { detail: { text: final.trim() } }));
      };
      r.onend = () => { this.listening = false; this.dispatchEvent(new Event('listen-end')); };
      r.onerror = e => { this.listening = false; this.dispatchEvent(new CustomEvent('error', { detail: { msg: e.error } })); };
      this._rec = r;
    }
    if (this.ttsSupported) {
      const pick = () => {
        const vs = speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'));
        // Prefer a male-ish English voice as a Brian stand-in; fall back to any English.
        this._voice = vs.find(v => /google.*(uk|us).*male|daniel|arthur|brian/i.test(v.name))
                   || vs.find(v => /google/i.test(v.name)) || vs[0] || null;
      };
      pick();
      speechSynthesis.onvoiceschanged = pick;
    }
  }

  listen() {
    if (!this._rec || this.listening) return;
    try { this._rec.start(); this.listening = true; }
    catch (e) { this.dispatchEvent(new CustomEvent('error', { detail: { msg: e.message } })); }
  }
  stopListening() { if (this._rec && this.listening) this._rec.stop(); }

  speak(text) {
    return new Promise(resolve => {
      if (!this.ttsSupported || !text) { resolve(); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this._voice) u.voice = this._voice;
      u.rate = 1.02; u.pitch = 1.0;
      u.onstart = () => this.dispatchEvent(new Event('speak-start'));
      u.onend = () => { this.dispatchEvent(new Event('speak-end')); resolve(); };
      u.onerror = () => { this.dispatchEvent(new Event('speak-end')); resolve(); };
      speechSynthesis.speak(u);
    });
  }
}
