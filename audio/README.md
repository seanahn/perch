# Perch Audio

Microphone capture for [Perch](https://marketplace.visualstudio.com/items?itemName=seanahn.perch) dictation.

Perch runs where your workspace is. Over Remote-SSH that is another
machine, which cannot reach your microphone. Perch Audio runs on the
computer you sit at, records when Perch asks it to, and hands the
recording over. Perch turns it into text.

It is installed with Perch; there is nothing to set up. On its own it does
nothing.

- `Perch Audio: Choose Microphone…` picks the microphone to record from.
- `perchAudio.device` names it; empty uses the system default.
- `perchAudio.maxSeconds` is how long a recording may run, 180 by default.

Audio is held in memory only while a recording is in progress. Nothing is
written to disk, and nothing here reads workspace files.
