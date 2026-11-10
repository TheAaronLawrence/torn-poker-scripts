# Torn poker scripts

Tampermonkey userscripts for Torn's Texas hold'em tables.

- **Torn Poker Advisor** shows advice inside Torn's poker panel, with hand strength, win chance, draws and a bet slider. It also keeps notes and stats on opponents and tracks your sessions.
- **Torn Poker Recorder** records table updates to a file, for debugging.

Both scripts read the table from the page. They never click Torn's buttons, and they send nothing anywhere. Data stays in Tampermonkey's storage on your machine.

## Install

Open the `.user.js` file for the script you want, then press Raw. Tampermonkey offers to install it, and checks this repo for updates after that.

- [torn-poker-advisor.user.js](torn-poker-advisor.user.js)
- [torn-poker-recorder.user.js](torn-poker-recorder.user.js)

This repo holds built files only. Each `.user.js` is a small loader that pulls in the matching `.js` build for its release.
