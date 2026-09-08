# Changelog

All notable changes to `rafai-ai-interface` are recorded here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every change to this repository gets an entry — no exceptions, including ones
that ship no new behaviour.

---

## [Unreleased]

### Fixed

- **"Failed to fetch" no longer loses an answer that was actually saved.**
  `fetch` only rejects on a network-level failure, so that message meant the
  socket died — not that the service failed. A long answer outlives a reverse
  proxy's read timeout (nginx `proxy_read_timeout` defaults to 60 s), while the
  service, which never learns the socket closed, finishes and stores the turn.
  Users saw an error, refreshed, and found the complete answer waiting.

  `ask()` in `src/api.ts` now raises `ConnectionLostError` for that case only,
  and `recoverAskResult` polls the thread for the answer that is about to
  appear (12 attempts, 5 s apart). The bubble stays **pending** while it looks —
  the work really is still in flight, and flashing an error about to be
  retracted is worse than a longer wait. A first message with no conversation
  id yet is handled by checking the newest thread.

  A recovered turn must be **the last turn in the thread** *and* carry an id
  the client has not seen. Matching on question text alone would return a
  months-old answer to a question asked twice — a stale figure served as a
  fresh one, which is a worse failure than the error it replaces.

  This makes the UI honest when a proxy timeout is hit. It does not stop it
  being hit — raising `proxy_read_timeout` is still worth doing.

- **The SQL inspector no longer blames the user's role for every refusal.**
  The badge tooltip read "Refused: outside this role's access". In the trace
  that prompted this, none of the three refusals were access refusals — two
  were `SELECT *`, one was a parser limitation. Anyone reading that trail
  concluded their role was too junior for data that was fully available to
  them. `src/components/SqlInspector.tsx` now says "Refused before it reached
  the database — open for the reason", with the same correction to the
  per-step fallback text.

### Notes

- `react-router-dom` is declared in `package.json` but is not installed, so the
  interface will not build until `npm install` is run. This predates the work
  above and is why `package-lock.json` was already modified.
