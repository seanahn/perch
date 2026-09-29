'use strict';
// Perch Audio: microphone capture for Perch dictation.
//
// This extension runs on the UI side, the machine you are sitting at, whatever the workspace is. Perch itself runs with
// the workspace, which under Remote-SSH is another machine with no access to your microphone. Perch asks this extension
// to record, through the commands below, and does the speech-to-text itself. Nothing here reads workspace files, and
// audio is held in memory only while a recording is in progress.
const vscode = require('vscode');
const { execFileSync } = require('child_process');
const { Recorder, pickDevice, probeInputs, isMonitor } = require('./recorder');

const API = 1;
let lib = null, libError = null, active = null;
let exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });

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
    vscode.commands.registerCommand('perchAudio.listDevices', () => chooseDevice()),
    { dispose: () => { if (active) { const a = active; active = null; a.rec.cancel(); } } },
  );
}
function deactivate() { if (active) { const a = active; active = null; return a.rec.cancel(); } }

module.exports = { activate, deactivate, _reset: (o) => { lib = null; libError = null; active = null; if (o && o.exec) exec = o.exec; } };
