# Perch — development install, packaging, and marketplace publish
#
# Publishing needs a one-time setup, the same as AI Meter's:
#   1. A publisher at https://marketplace.visualstudio.com/manage
#      (it must match "publisher" in package.json)
#   2. An Azure DevOps PAT (org: All accessible, scope: Marketplace > Manage)
#   3. Either 'make login' once, the token in ~/.ssh/azure-dev.pat, or VSCE_PAT=<token> in .env
#
-include .env
PAT_FILE = $(HOME)/.ssh/azure-dev.pat
ifeq ($(VSCE_PAT),)
VSCE_PAT = $(shell [ -r $(PAT_FILE) ] && tr -d '\n' < $(PAT_FILE))
endif
export VSCE_PAT

VSCE = npx --yes @vscode/vsce
VERSION = $(shell node -p "require('./package.json').version")
PUBLISHER = $(shell node -p "require('./package.json').publisher")
VSIX = perch-$(VERSION).vsix

EXT_ID = seanahn.perch-$(VERSION)
# links made under earlier versions, and under the publisher id perch had before it was published
OLD_IDS = fennets.perch-0.1.0 fennets.perch-0.2.0 fennets.perch-0.3.0 fennets.perch-0.4.0 fennets.perch-0.5.0 fennets.perch-0.6.0 seanahn.perch-0.6.0 seanahn.perch-0.6.1 seanahn.perch-0.6.2 seanahn.perch-0.6.3 seanahn.perch-0.6.4 seanahn.perch-0.6.5 seanahn.perch-0.6.6 seanahn.perch-0.6.7 seanahn.perch-0.6.8 seanahn.perch-0.6.9 seanahn.perch-0.6.10 seanahn.perch-0.6.11 seanahn.perch-0.6.12 seanahn.perch-0.6.13 seanahn.perch-0.6.14 seanahn.perch-0.6.15 seanahn.perch-0.6.16
AUDIO_ID = seanahn.perch-audio-$(shell node -p "require('./audio/package.json').version")
OLD_AUDIO_IDS = fennets.perch-audio-0.1.0 seanahn.perch-audio-0.1.0
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
## The speech-to-text engine is one source, src/voice.js and voice/, copied into perch-audio so both extensions can be packaged with it
audio-engine:
	@mkdir -p audio/voice && cp src/voice.js audio/src/engine.js && cp voice/server.py voice/requirements.txt audio/voice/

install-audio: audio-engine
	@cd audio && npm install --silent && npm test --silent
	@for d in $(AUDIO_DIRS); do for o in $(OLD_AUDIO_IDS); do rm -f $$d/$$o; done; [ -d $$d ] && ln -sfn /git/perch/audio $$d/$(AUDIO_ID) && echo "linked $$d/$(AUDIO_ID)"; done; true
	@echo "perch-audio installed. Reload the window to activate."

## Build perch-audio as a .vsix, to install on the computer you connect from (code --install-extension perch-audio-*.vsix)
package-audio: audio-engine
	cd audio && npm install --silent && $(VSCE) package

## Publish Perch Audio. Perch installs it, so it is published first: 'make publish' does both, in that order
publish-audio: audio-engine
	cd audio && npm install --silent && npm test --silent && $(VSCE) publish

## Remove the symlinks
uninstall:
	@for d in $(EXT_DIRS); do rm -f $$d/$(EXT_ID); for o in $(OLD_IDS); do rm -f $$d/$$o; done; done; for d in $(AUDIO_DIRS); do rm -f $$d/$(AUDIO_ID); for o in $(OLD_AUDIO_IDS); do rm -f $$d/$$o; done; done; echo "perch unlinked"

## Build a .vsix. The SDKs are inside; the agents' programs are not: Perch runs those of the vendors' extensions
package: deps check
	$(VSCE) package

## Install the packaged .vsix into this machine's VS Code, in place of the development symlink
install-vsix: package uninstall
	@command -v code-server >/dev/null 2>&1 && code-server --install-extension $(VSIX) --force \
		|| code --install-extension $(VSIX) --force

## One-time: store the marketplace PAT for the publisher in package.json
login:
	$(VSCE) login $(PUBLISHER)

## Publish the version in package.json to the marketplace, after Perch Audio, which it brings with it.
## Perch Audio is published only when its version is not the one already there
publish: deps check
	@cd audio && ($(VSCE) show $(PUBLISHER).perch-audio --json 2>/dev/null | grep -q '"version": "'$$(node -p "require('./package.json').version")'"' && echo "perch-audio is already published at this version") || $(MAKE) -C .. publish-audio
	$(VSCE) publish

## Bump the version (this also makes the git commit and tag), then publish
publish-patch: deps check
	$(VSCE) publish patch

publish-minor: deps check
	$(VSCE) publish minor

clean:
	rm -f *.vsix

.PHONY: deps check test test-offline install audio-engine install-audio package-audio uninstall package install-vsix login publish publish-audio publish-patch publish-minor clean
