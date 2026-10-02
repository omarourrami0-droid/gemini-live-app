'use strict';

/* ---------- الإعدادات ---------- */
const STORE_KEY = 'gemini-live-settings-v1';
// ملاحظة: لا نضبط languageCode لأنه جعل النموذج يتبع تفريغ الصوت الخاطئ (إسبانية بدل الدارجة).
const DEFAULT_SYSTEM =
  'أنت مساعد صوتي ودود اسمه «جيميني». المستخدم مغربي ويتكلم غالباً بالدارجة المغربية مع كلمات فرنسية، وهذا هو الافتراض دائماً. ' +
  'قد يكون التسجيل الصوتي غير واضح، فلا تفترض أبداً أنه يتكلم الإسبانية أو الإيطالية أو الفرنسية الخالصة. ' +
  'أجب دائماً بالدارجة المغربية الطبيعية في جملة أو جملتين قصيرتين، ولا تغيّر لغتك إلا إذا طلب ذلك صراحةً أو كتب جملة كاملة بلغة أخرى. ' +
  'ولا تستعمل قوائم ولا رموزاً.';
const MODELS = [
  ['gemini-3.8-live', 'gemini-3.8-live (الموصى به)'],
  ['gemini-3.1-flash-live-preview', 'gemini-3.1-flash-live-preview'],
  ['gemini-2.5-flash-native-audio-latest', 'gemini-2.5-flash-native-audio (أضعف)'],
];
const VOICES = ['Kore', 'Puck', 'Aoede', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Zephyr'];
const DEFAULTS = { apiKey: '', model: MODELS[0][0], voice: 'Kore', system: DEFAULT_SYSTEM, muteWhileSpeaking: false };
const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const IN_RATE = 16000, OUT_RATE = 24000;

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {} }
let settings = loadSettings();

/* ---------- عناصر الواجهة ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  orb: $('orb'), status: $('status'), timer: $('timer'), log: $('log'), empty: $('empty'),
  call: $('call'), callLabel: $('callLabel'), callIcon: $('callIcon'), mute: $('muteBtn'), muteSlash: $('muteSlash'),
  kb: $('kbBtn'), textRow: $('textRow'), textIn: $('textIn'), chip: $('modelChip'),
  dlg: $('dlg'), form: $('settingsForm'), fKey: $('fKey'), fModel: $('fModel'), fVoice: $('fVoice'),
  fSystem: $('fSystem'), fMuteSpeak: $('fMuteSpeak'),
};
const ICON_MIC = '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>';
const ICON_STOP = '<rect x="6" y="6" width="12" height="12" rx="2"/>';

/* ---------- حالة الجلسة ---------- */
let ws = null, ready = false, userStopped = true, retries = 0, resumeHandle = null;
let micStream = null, micCtx = null, micNode = null, micLevel = 0;
let playCtx = null, outGain = null, outAnalyser = null, nextPlay = 0;
const sources = new Set();
let muted = false, status = 'idle', startedAt = 0, timerId = 0, rafId = 0, wakeLock = null;
let curUser = null, curModel = null;

/* ---------- أدوات صغيرة ---------- */
function b64FromBuf(buf) {
  const u8 = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u8.length; i += 0x2000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x2000));
  return btoa(s);
}
function int16FromB64(b64) {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Int16Array(u8.buffer, 0, u8.length >> 1);
}
function setStatus(s, text) {
  status = s; el.orb.dataset.s = s;
  if (text != null) el.status.textContent = text;
}
function addMsg(cls, text) {
  if (el.empty) { el.empty.remove(); el.empty = null; }
  const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text;
  el.log.appendChild(d); el.log.scrollTop = el.log.scrollHeight; return d;
}
function appendTo(node, text) { node.textContent += text; el.log.scrollTop = el.log.scrollHeight; }
function fmtTime(ms) { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }

/* ---------- الصوت: الميكروفون (16kHz) ---------- */
const WORKLET_SRC = `
class Down extends AudioWorkletProcessor {
  constructor(){ super(); this.t=0; this.prev=0; this.out=new Int16Array(512); this.n=0; this.sq=0; }
  process(inputs){
    const x = inputs[0][0]; if(!x) return true;
    const step = sampleRate / ${IN_RATE};
    while (this.t < x.length - 1) {
      const i = Math.floor(this.t), f = this.t - i;
      const a = i < 0 ? this.prev : x[i], b = x[i+1];
      let v = a + (b - a) * f; v = v > 1 ? 1 : v < -1 ? -1 : v;
      this.out[this.n++] = v < 0 ? v * 32768 : v * 32767; this.sq += v * v;
      if (this.n === 512) {
        const buf = this.out.buffer;
        this.port.postMessage({ pcm: buf, rms: Math.sqrt(this.sq / 512) }, [buf]);
        this.out = new Int16Array(512); this.n = 0; this.sq = 0;
      }
      this.t += step;
    }
    this.t -= x.length; this.prev = x[x.length - 1];
    return true;
  }
}
registerProcessor('down', Down);`;

async function startMic() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    throw new Error('الميكروفون يتطلب اتصالاً آمناً (HTTPS).');
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  micCtx = new (window.AudioContext || window.webkitAudioContext)();
  await micCtx.resume();
  const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
  await micCtx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
  const src = micCtx.createMediaStreamSource(micStream);
  micNode = new AudioWorkletNode(micCtx, 'down');
  micNode.port.onmessage = (e) => {
    micLevel = e.data.rms;
    if (!ready || !ws || ws.readyState !== WebSocket.OPEN || muted) return;
    if (settings.muteWhileSpeaking && isModelSpeaking()) return;
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64FromBuf(e.data.pcm), mimeType: 'audio/pcm;rate=' + IN_RATE } } }));
  };
  src.connect(micNode); // لا نوصّله بالمخرج لتجنّب الصدى
}

/* ---------- الصوت: التشغيل (24kHz) ---------- */
function initPlayback() {
  playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUT_RATE });
  outGain = playCtx.createGain();
  outAnalyser = playCtx.createAnalyser(); outAnalyser.fftSize = 512;
  outGain.connect(outAnalyser); outAnalyser.connect(playCtx.destination);
  playCtx.resume();
  nextPlay = 0;
}
function isModelSpeaking() { return !!playCtx && playCtx.currentTime < nextPlay - 0.03; }
function enqueueAudio(b64) {
  const i16 = int16FromB64(b64), f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  const buf = playCtx.createBuffer(1, f32.length, OUT_RATE); buf.copyToChannel(f32, 0);
  const s = playCtx.createBufferSource(); s.buffer = buf; s.connect(outGain);
  const at = Math.max(nextPlay, playCtx.currentTime + 0.04);
  s.start(at); nextPlay = at + buf.duration;
  sources.add(s); s.onended = () => sources.delete(s);
}
function flushPlayback() {
  for (const s of sources) { try { s.stop(); } catch {} }
  sources.clear(); nextPlay = 0;
}

/* ---------- الاتصال بـ Gemini Live ---------- */
function buildSetup() {
  const setup = {
    model: 'models/' + settings.model,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } },
    },
    systemInstruction: { parts: [{ text: settings.system || DEFAULT_SYSTEM }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
  };
  return { setup };
}

function openSocket() {
  ready = false;
  ws = new WebSocket(WS_BASE + '?key=' + encodeURIComponent(settings.apiKey));
  ws.binaryType = 'arraybuffer';
  const mine = ws;
  ws.onopen = () => mine.send(JSON.stringify(buildSetup()));
  ws.onmessage = (ev) => {
    if (mine !== ws) return;
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); } catch { return; }
    onServerMessage(msg);
  };
  ws.onerror = () => {};
  ws.onclose = (ev) => { if (mine === ws) onClosed(ev); };
}

function onServerMessage(m) {
  if (m.setupComplete) {
    ready = true; retries = 0;
    if (!startedAt) { startedAt = Date.now(); timerId = setInterval(() => { el.timer.textContent = fmtTime(Date.now() - startedAt); }, 500); }
    setStatus('listening', muted ? 'الميكروفون مكتوم' : 'أستمع إليك… تكلّم');
    el.call.disabled = false;
    return;
  }
  if (m.sessionResumptionUpdate?.newHandle) resumeHandle = m.sessionResumptionUpdate.newHandle;
  if (m.goAway) addMsg('note', 'سيُعاد الاتصال تلقائياً…');
  const sc = m.serverContent; if (!sc) return;

  if (sc.interrupted) { flushPlayback(); curModel = null; }
  for (const p of sc.modelTurn?.parts || []) {
    if (p.inlineData?.data && playCtx) enqueueAudio(p.inlineData.data);
  }
  if (sc.inputTranscription?.text) {
    curModel = null;
    if (!curUser) curUser = addMsg('user', '');
    appendTo(curUser, sc.inputTranscription.text);
  }
  if (sc.outputTranscription?.text) {
    curUser = null;
    if (!curModel) curModel = addMsg('model', '');
    appendTo(curModel, sc.outputTranscription.text);
  }
  if (sc.turnComplete) { curUser = null; curModel = null; }
}

function onClosed(ev) {
  const wasReady = ready; ready = false;
  if (userStopped) return;
  if (wasReady && retries < 3) {
    retries++; setStatus('connecting', 'إعادة الاتصال…');
    setTimeout(() => { if (!userStopped) openSocket(); }, 400 * retries);
    return;
  }
  const why = ev.reason ? ev.reason : 'رمز ' + ev.code;
  fail(wasReady ? 'انقطع الاتصال: ' + why
    : ev.code === 1008 || /api key|permission|invalid/i.test(ev.reason || '')
      ? 'رفضت Google المفتاح: ' + why
      : 'تعذّر الاتصال: ' + why);
}

/* ---------- بدء الجلسة وإنهاؤها ---------- */
async function start() {
  if (!settings.apiKey) { openSettings(); return; }
  userStopped = false; retries = 0; resumeHandle = null; startedAt = 0; muted = false;
  el.log.querySelectorAll('.msg').forEach((n) => n.remove());
  curUser = curModel = null;
  setStatus('connecting', 'جارٍ الاتصال…');
  el.call.disabled = true; el.callLabel.textContent = 'جارٍ الاتصال…';
  try {
    initPlayback();          // داخل نقرة المستخدم لفتح الصوت على iOS
    await startMic();
  } catch (e) {
    fail(e.name === 'NotAllowedError' ? 'تم رفض إذن الميكروفون. فعّله من إعدادات المتصفح.' : (e.message || String(e)));
    return;
  }
  setLiveUI(true);
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  openSocket();
  loop();
}

function stop(finalText) {
  userStopped = true; ready = false;
  try { ws?.close(1000); } catch {}
  ws = null;
  flushPlayback();
  micNode?.disconnect(); micNode = null;
  micStream?.getTracks().forEach((t) => t.stop()); micStream = null;
  micCtx?.close().catch(() => {}); micCtx = null;
  playCtx?.close().catch(() => {}); playCtx = null;
  try { wakeLock?.release(); } catch {} wakeLock = null;
  clearInterval(timerId); timerId = 0; cancelAnimationFrame(rafId); rafId = 0;
  el.orb.style.setProperty('--lv', 0);
  setLiveUI(false);
  if (status !== 'error') setStatus('idle', finalText || 'انتهت المحادثة. اضغط للبدء من جديد.');
}

function fail(text) {
  setStatus('error', text);
  addMsg('note', text);
  stop(); // لا يمسح حالة الخطأ
  el.status.textContent = text;
}

function setLiveUI(live) {
  el.call.classList.toggle('live', live);
  el.call.disabled = false;
  el.callLabel.textContent = live ? 'إنهاء' : 'ابدأ المحادثة';
  el.callIcon.innerHTML = live ? ICON_STOP : ICON_MIC;
  el.mute.disabled = !live;
  if (!live) { muted = false; syncMute(); }
}

/* ---------- حلقة الرسم: مستوى الصوت والحالة ---------- */
function loop() {
  const data = new Uint8Array(outAnalyser ? outAnalyser.fftSize : 0);
  const tick = () => {
    rafId = requestAnimationFrame(tick);
    if (!ready) return;
    const speaking = isModelSpeaking();
    let lv = 0;
    if (speaking && outAnalyser) {
      outAnalyser.getByteTimeDomainData(data);
      let sq = 0; for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sq += v * v; }
      lv = Math.min(1, Math.sqrt(sq / data.length) * 3.2);
    } else if (!muted) {
      lv = Math.min(1, micLevel * 6);
    }
    el.orb.style.setProperty('--lv', lv.toFixed(3));
    const want = speaking ? 'speaking' : 'listening';
    if (status !== want && (status === 'listening' || status === 'speaking')) {
      setStatus(want, speaking ? 'جيميني يتكلّم…' : (muted ? 'الميكروفون مكتوم' : 'أستمع إليك… تكلّم'));
    }
  };
  tick();
}

/* ---------- الأزرار ---------- */
function syncMute() {
  el.mute.setAttribute('aria-pressed', String(muted));
  el.muteSlash.style.display = muted ? '' : 'none';
}
el.call.addEventListener('click', () => { if (userStopped) start(); else stop(); });
el.mute.addEventListener('click', () => {
  muted = !muted; syncMute();
  if (muted && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  if (status === 'listening') setStatus('listening', muted ? 'الميكروفون مكتوم' : 'أستمع إليك… تكلّم');
});
el.kb.addEventListener('click', () => { el.textRow.classList.toggle('open'); if (el.textRow.classList.contains('open')) el.textIn.focus(); });
el.textRow.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = el.textIn.value.trim();
  if (!t || !ready || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ realtimeInput: { text: t } }));
  curUser = null; addMsg('user', t); el.textIn.value = '';
});
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && !userStopped && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  }
});

/* ---------- الإعدادات ---------- */
function fillSelects() {
  el.fModel.innerHTML = MODELS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  el.fVoice.innerHTML = VOICES.map((v) => `<option>${v}</option>`).join('');
}
function openSettings() {
  el.fKey.value = settings.apiKey; el.fModel.value = settings.model; el.fVoice.value = settings.voice;
  el.fSystem.value = settings.system; el.fMuteSpeak.checked = settings.muteWhileSpeaking;
  el.dlg.showModal();
}
$('settingsBtn').addEventListener('click', openSettings);
el.form.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  settings = {
    apiKey: el.fKey.value.trim(), model: el.fModel.value, voice: el.fVoice.value,
    system: el.fSystem.value.trim() || DEFAULT_SYSTEM, muteWhileSpeaking: el.fMuteSpeak.checked,
  };
  saveSettings(settings); el.chip.textContent = settings.model;
});
$('resetSys').addEventListener('click', () => { el.fSystem.value = DEFAULT_SYSTEM; });
$('clearKey').addEventListener('click', () => { el.fKey.value = ''; settings.apiKey = ''; saveSettings(settings); });

/* ---------- تشغيل أولي ---------- */
fillSelects();
el.chip.textContent = settings.model;
syncMute();
if (!settings.apiKey) setStatus('idle', 'أضف مفتاح Gemini من الإعدادات أولاً');
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
