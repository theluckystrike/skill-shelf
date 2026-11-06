# Changelog

## 0.1.2 (2026-11-06)

- Skill Shelf asks one time for a Marketplace rating. It counts each success (a session where the Agent Skills view shows your skills). After 5 of them, and no sooner than 2 days after the first, it shows a small message with "Rate it", "Later" and "Don't ask again". "Later" waits for 20 more, at most two more times. It never shows in your first session, more than once per session, when the window is not focused, or in a remote or untrusted workspace.
- New setting `agentSkills.askForRating` (default `true`) turns it off. Nothing is sent anywhere; "Rate it" only opens the review page in your browser.

## 0.1.1 (2026-11-06)

- Listing only, no change to the extension. The display name is now "Agent Skills & Claude Skills (Skill Shelf)" and the description is one sentence, so the listing uses the words people search for (agent skills (25), claude skills (11), skills (89)).
- The 30 keywords start with the most searched terms.
- The README ends with links to the other Zovo extensions.

## 0.1.0 (2026-11-06)
- First release, as Skill Shelf (`zovo.skill-shelf`).
- Agent Skills tree with 23 known skill folders for Claude Code, Codex, Cursor, GitHub Copilot, Windsurf, Devin, Gemini CLI, OpenCode, Amp, Junie, Roo Code and Kiro, in project and user scope. Add more folders with `agentSkills.extraLocations`.
- SKILL.md checks based on the Agent Skills spec, with line numbers in the tree and the Problems panel.
- Disable and Enable (moves the folder to a hidden sibling folder after a confirmation), Copy Skill To…, Create Skill…, Reveal, Open.
- Install Skills from GitHub builds the `skills` CLI command and shows it. You copy it or paste it into a terminal and run it yourself. The extension starts no processes.
- Copy skips secret-looking files and symlinks that point outside the skill. A SKILL.md that links outside its folder is not read. Hover text is escaped.
- Read-only in Restricted Mode. No network calls, no telemetry.
