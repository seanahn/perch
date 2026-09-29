EXT_ID = fennets.perch-0.6.0
OLD_IDS = fennets.perch-0.1.0 fennets.perch-0.2.0 fennets.perch-0.3.0 fennets.perch-0.4.0 fennets.perch-0.5.0
AUDIO_ID = fennets.perch-audio-0.1.0
# Perch Audio records from the microphone, so it belongs where the user sits: the desktop's extensions, not a server's
AUDIO_DIRS = /home/sahn/.vscode/extensions /home/sahn/.local/share/code-server/extensions
EXT_DIRS = /home/sahn/.vscode/extensions /home/sahn/.local/share/code-server/extensions /home/sahn/.vscode-server/extensions

## Install node dependencies (both agent SDKs; the Codex SDK pulls in the codex binary)
deps:
	npm install --silent
	cd audio && npm install --silent

## Syntax-check the extension sources
check:
	npm run -s check

## Host and page tests, then one tiny live turn through each agent (uses your real logins)
test:
	npm run -s test

## Host and page tests only: no model calls
test-offline:
	npm run -s test:offline

## Symlink this checkout into every VS Code / code-server extension dir, like the fennets extensions
install: deps check install-audio
	@for d in $(EXT_DIRS); do for o in $(OLD_IDS); do rm -f $$d/$$o; done; [ -d $$d ] && ln -sfn /git/perch $$d/$(EXT_ID) && echo "linked $$d/$(EXT_ID)"; done; true
	@echo "perch installed. Reload the window to activate."

## Symlink Perch Audio, the microphone companion, into this machine's own VS Code
install-audio:
	@cd audio && npm install --silent && node test/recorder.test.js
	@for d in $(AUDIO_DIRS); do [ -d $$d ] && ln -sfn /git/perch/audio $$d/$(AUDIO_ID) && echo "linked $$d/$(AUDIO_ID)"; done; true
	@echo "perch-audio installed. Reload the window to activate."

## Build perch-audio as a .vsix, to install on the computer you connect from (code --install-extension perch-audio-*.vsix)
package-audio:
	cd audio && npm install --silent && npx --yes @vscode/vsce package --allow-missing-repository

## Remove the symlinks
uninstall:
	@for d in $(EXT_DIRS); do rm -f $$d/$(EXT_ID); for o in $(OLD_IDS); do rm -f $$d/$$o; done; done; for d in $(AUDIO_DIRS); do rm -f $$d/$(AUDIO_ID); done; echo "perch unlinked"

## Build a .vsix (production dependencies are bundled; tests and dev dependencies are not)
package: deps check
	npx vsce package

.PHONY: deps check test test-offline install install-audio package-audio uninstall package
