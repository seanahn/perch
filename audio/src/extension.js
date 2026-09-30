'use strict';
// Perch Audio: microphone capture for Perch dictation.
//
// This extension runs on the UI side, the machine you are sitting at, whatever the workspace is. Perch itself runs with
// the workspace, which under Remote-SSH is another machine with no access to your microphone. Perch asks this extension
// to record, through the commands below. The speech-to-text can happen here too (engine.js, the same engine Perch has,
// copied in at build time): when this computer has a GPU and the workspace machine does not, only the text crosses.
// Nothing here reads workspace files, and audio is held in memory only while a recording is in progress.
const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Recorder, pickDevice, probeInputs, isMonitor } = require('./recorder');

const API = 2;                       // 2: can transcribe here (engine, setup, warm, transcribe, unload)
let lib = null, libError = null, active = null;
let exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
let Engine = null, engineError = null, engine = null, engineKey = '', gpu = null;

function engineClass() {
  if (Engine || engineError) return Engine;
  try { Engine = require('./engine').VoiceEngine; } catch (e) { engineError = String((e && e.message) || e); }
  return Engine;
}
/** Whether this computer has an NVIDIA GPU, which is what makes transcribing here worth it. Asked once. */
function hasGpu() {
  if (gpu !== null) return gpu;
  try { gpu = /\bGPU \d/.test(exec('nvidia-smi', ['-L'])); } catch (_) { gpu = false; }
  return gpu;
}
const NO_ENGINE = 'This Perch Audio cannot transcribe: its speech-to-text engine is missing. Reinstall it from the marketplace, or set perch.voice.runOn to remote.';
/** One engine per combination of settings, as Perch keeps its own; the settings arrive with each request. */
function getEngine(o) {
  const E = engineClass(); if (!E) return null;
  o = o || {};
  const opts = { model: o.model || 'auto', device: o.device || 'auto', python: o.python || undefined, idleMs: o.idleMs === undefined ? 10 * 60000 : o.idleMs };
  const key = JSON.stringify(opts);
  if (!engine || engineKey !== key) {
    if (engine) engine.stop();
    engine = new E(Object.assign({ server: path.join(__dirname, '..', 'voice', 'server.py'), requirements: path.join(__dirname, '..', 'voice', 'requirements.txt') }, opts));
    engineKey = key;
  }
  return engine;
}
function engineStatus(o) {
  const e = getEngine(o); if (!e) return fail(NO_ENGINE, 'no-engine');
  return { ok: true, installed: e.isInstalled(), gpu: hasGpu(), home: e.home, host: os.hostname() };
}
/** The one-time setup on this computer. Perch asks the user first; the progress shows here, in the same window. */
async function setup(o) {
  const e = getEngine(o); if (!e) return fail(NO_ENGINE, 'no-engine');
  if (e.isInstalled()) return { ok: true };
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Perch voice input', cancellable: false }, async (progress) => {
      let last = 0;
      await e.install((message, pct) => { progress.report({ message, increment: Math.max(0, pct - last) }); last = pct; });
    });
    return { ok: true };
  } catch (err) { return fail(err.message, 'setup-failed'); }
}
/** Load the model now, while the user is still speaking. */
function warm(o) { const e = getEngine(o); if (e) e.start().catch(() => {}); return { ok: !!e }; }
/** Stop the recording and turn it into text here. What comes back is the text, not the audio. */
async function transcribe(id, o) {
  o = o || {};
  const r = await stop(id); if (!r.ok) return r;
  const meta = { seconds: r.seconds, silent: r.silent, device: r.device, ended: r.ended };
  if (r.silent || r.seconds < 0.3) return Object.assign({ ok: true, text: '' }, meta);
  const e = getEngine(o.engine); if (!e) return fail(NO_ENGINE, 'no-engine');
  try {
    const out = await e.transcribe({ pcm: r.pcm, sampleRate: r.sampleRate, language: o.language || null, prompt: o.prompt || null });
    return Object.assign({ ok: true, text: String(out.text || ''), language: out.language, took_ms: out.took_ms }, meta);
  } catch (err) { return fail(err.message, 'transcribe-failed'); }
}
function unload() { if (engine) engine.stop(); return { ok: true }; }

function library() {
  if (lib || libError) return lib;
  try { lib = require('@picovoice/pvrecorder-node').PvRecorder; } catch (e) { libError = String((e && e.message) || e); }
  return lib;
}
const cfg = (k) => vscode.workspace.getConfiguration('perchAudio').get(k);
const fail = (error, code) => ({ ok: false, error, code });

function available() {
  const L = library();
  if (!L) return Object.assign(fail('The recorder could not be loaded on this machine: ' + libError, 'no-library'), { api: API });
  let devices;
  try { devices = L.getAvailableDevices(); } catch (e) { return Object.assign(fail('Could not list microphones: ' + e.message, 'no-devices'), { api: API }); }
  const states = probeInputs(exec);
  const inputs = devices.filter((d) => !isMonitor(d));
  if (!inputs.length) return Object.assign(fail('No microphone was found on this computer.', 'no-microphone'), { api: API, devices, states });
  const wanted = cfg('device'), chosen = wanted && devices.find((d) => d.trim().toLowerCase() === String(wanted).trim().toLowerCase());
  // a device chosen on purpose is used as it is; otherwise an input with nothing plugged into it is not a microphone
  if (!chosen && inputs.every((d) => states[d] === 'unplugged')) {
    return Object.assign(fail('No microphone is connected to this computer: nothing is plugged into ' + (inputs.length === 1 ? 'its audio input' : 'any of its audio inputs') + '. Plug in a microphone or a headset, or dictate from a computer that has one, connected to this workspace over Remote-SSH with Perch Audio installed there.', 'no-microphone'), { api: API, devices, states });
  }
  const pick = pickDevice(devices, wanted, states);
  return { ok: true, api: API, devices, states, device: pick.name, busy: !!active };
}

function start() {
  const a = available();
  if (!a.ok) return a;
  if (active) return fail('A recording is already in progress.', 'busy');
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const rec = new Recorder({ PvRecorder: library(), device: cfg('device'), maxSeconds: cfg('maxSeconds'), states: a.states });
  try { const s = rec.start(); active = { id, rec }; return Object.assign({ ok: true, id, maxSeconds: rec.maxSeconds }, s); }
  catch (e) { return fail('Could not open the microphone: ' + ((e && e.message) || e) + '. Your system may be asking for microphone permission, or another program may be holding the device.', 'capture-failed'); }
}

const mine = (id) => (active && active.id === id ? active : null);
function level(id) { const a = mine(id); return a ? Object.assign({ ok: true }, a.rec.level()) : fail('No such recording.', 'unknown'); }
async function stop(id) {
  const a = mine(id); if (!a) return fail('No such recording.', 'unknown');
  active = null;
  const r = await a.rec.stop();
  return { ok: true, pcm: r.pcm.toString('base64'), sampleRate: r.sampleRate, seconds: r.seconds, silent: r.peak === 0, device: r.device, ended: r.ended, error: r.error };
}
async function cancel(id) { const a = id === undefined ? active : mine(id); if (!a) return { ok: true }; active = null; await a.rec.cancel(); return { ok: true }; }

async function chooseDevice() {
  const a = available();
  if (!a.devices) { vscode.window.showErrorMessage('Perch Audio: ' + a.error); return; }
  const now = cfg('device') || '';
  const st = a.states || {};
  const items = [{ label: 'First microphone found', description: now ? '' : 'current', value: '' },
    ...a.devices.filter((d) => !isMonitor(d)).map((d) => ({ label: d, description: [st[d] === 'unplugged' ? 'nothing plugged in' : st[d] === 'available' ? 'connected' : '', d === now ? 'current' : ''].filter(Boolean).join(' · '), value: d })),
    ...a.devices.filter(isMonitor).map((d) => ({ label: d, description: 'records what the speakers play, not the room' + (d === now ? ' · current' : ''), value: d }))];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Microphone for Perch dictation' });
  if (pick) await vscode.workspace.getConfiguration('perchAudio').update('device', pick.value, vscode.ConfigurationTarget.Global);
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('_perch.audio.available', () => available()),
    vscode.commands.registerCommand('_perch.audio.start', () => start()),
    vscode.commands.registerCommand('_perch.audio.level', (id) => level(id)),
    vscode.commands.registerCommand('_perch.audio.stop', (id) => stop(id)),
    vscode.commands.registerCommand('_perch.audio.cancel', (id) => cancel(id)),
    vscode.commands.registerCommand('_perch.audio.engine', (o) => engineStatus(o)),
    vscode.commands.registerCommand('_perch.audio.setup', (o) => setup(o)),
    vscode.commands.registerCommand('_perch.audio.warm', (o) => warm(o)),
    vscode.commands.registerCommand('_perch.audio.transcribe', (id, o) => transcribe(id, o)),
    vscode.commands.registerCommand('_perch.audio.unload', () => unload()),
    vscode.commands.registerCommand('perchAudio.listDevices', () => chooseDevice()),
    { dispose: () => { if (active) { const a = active; active = null; a.rec.cancel(); } unload(); } },
  );
}
function deactivate() { unload(); if (active) { const a = active; active = null; return a.rec.cancel(); } }

module.exports = { activate, deactivate, _reset: (o) => { lib = null; libError = null; active = null; engine = null; engineKey = ''; gpu = null; Engine = null; engineError = null; if (o && o.exec) exec = o.exec; if (o && o.engine) Engine = o.engine; } };
