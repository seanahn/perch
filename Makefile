EXT_ID = fennets.perch-0.1.0
EXT_DIRS = /home/sahn/.vscode/extensions /home/sahn/.local/share/code-server/extensions /home/sahn/.vscode-server/extensions

## Install node dependencies (both agent SDKs; the Codex SDK pulls in the codex binary)
deps:
	npm install --silent

## Syntax-check the extension sources
check:
	npm run -s check

## Run the headless harness: one tiny turn through each agent, no VS Code needed
test:
	npm run -s test

## Symlink this checkout into every VS Code / code-server extension dir, like the fennets extensions
install: deps check
	@for d in $(EXT_DIRS); do [ -d $$d ] && ln -sfn /git/perch $$d/$(EXT_ID) && echo "linked $$d/$(EXT_ID)"; done; true
	@echo "perch installed. Reload the window to activate."

## Remove the symlinks
uninstall:
	@for d in $(EXT_DIRS); do rm -f $$d/$(EXT_ID); done; echo "perch unlinked"

## Build a .vsix (bundles node_modules)
package: deps check
	npx vsce package --no-dependencies

.PHONY: deps check test install uninstall package
