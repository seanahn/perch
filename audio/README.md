# Perch Audio

Microphone capture for [Perch](https://marketplace.visualstudio.com/items?itemName=seanahn.perch) dictation.

Perch runs where your workspace is. Over Remote-SSH that is another
machine, which cannot reach your microphone. Perch Audio runs on the
computer you sit at, records when Perch asks it to, and either hands the
recording over for Perch to turn into text, or turns it into text itself
and hands over the words. It does the latter when this computer has an
NVIDIA GPU (or `perch.voice.runOn` is `local`), with the same Whisper
engine Perch has, set up once into `~/.local/share/perch/voice` here.

It is installed with Perch. On its own it does nothing.

- `Perch Audio: Choose Microphone…` picks the microphone to record from.
  Bluetooth headsets are listed even while in their music profile; one is
  switched to headset mode for a recording and back after.
- `perchAudio.device` names it; empty uses the system default.
- `perchAudio.maxSeconds` is how long a recording may run, 180 by default.
- `perchAudio.saveRecordings`, a diagnostic: a directory on this computer
  where each recording is saved as a WAV, with a `transcripts.log` of what
  was heard when the words are worked out here. Empty, the default, saves
  nothing.

Audio is held in memory only while a recording is in progress. Nothing is
written to disk, and nothing here reads workspace files.
