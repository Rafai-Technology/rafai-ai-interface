# Changelog

All notable changes to `rafai-ai-interface` are recorded here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every change to this repository gets an entry — no exceptions, including ones
that ship no new behaviour.

---

## [Unreleased]

### Added

- **Every answer that ran a query shows its date range and row count.** A
  figure used to read as covering the whole database even when the query was
  filtered to a period or stopped at the row limit. `dataCoverage` in
  `src/answer.ts` works it out from the trace, never from the prose: it takes
  the query that returned the most rows (the list or series the answer is
  about, not a one-row check beside it), its row count, `limitReached`, the
  date filter read off the SQL by `sqlDateFilter` (fixed date literals on a
  date column, including `BETWEEN` and `<` turned into an inclusive last day;
  `GETDATE`/`DATEADD`/`MONTH(...)` style filters reported as "Filtered
  period"; none as "All dates"), and the earliest and latest date present in
  the rows. `CoverageBar` in `src/components/ChatPanel.tsx` shows it above the
  answer: the period, a "Partial data" tag when there was a date filter or the
  row limit was hit (otherwise "All matching data"), "20 rows · data from
  1 Apr 2026 – 3 Apr 2026", and "row limit reached — more rows exist". Answers
  with a scope block keep `ScopeBar`, which now also shows the row count.


- **The first line acknowledges the question while the loader runs.** The
  service now sends an `ack` event with the one-line acknowledgement the model
  writes before its first tool ("Theek hai, sabse purane 20 consignments nikal
  raha hoon — thoda time dijiye"). `askStream` in `src/api.ts` passes it to
  `onAck`, `App.tsx` keeps it on `live.ack`, and `Pending` in
  `src/components/ChatPanel.tsx` shows it at full weight **above** the loader
  for the whole wait, with later step text and the answer being written below
  the loader as before. Text written before any step starts is shown in the
  same place, so the line does not move when the `ack` arrives. The finished
  answer replaces it.

- **A list answer shows its period and counts above the answer.** `parseAnswer`
  in `src/answer.ts` takes the ```scope block out of the reply (a label is
  required; a malformed block shows no header) and the new `scopeCounts` reads
  `period_count` and `total_all` off the last successful query that returned
  them — never from the prose. `ScopeBar` in `src/components/ChatPanel.tsx`
  shows the period with a calendar icon and a "default" tag when no period was
  asked for, "412 consignments of 18,432 in total", and "showing the latest
  500" when the list stopped at the row cap. Chips for Last month, Last 3
  months, This FY and All time ask the same list for that period through
  `onAsk`, disabled while an answer is in flight. A count that is missing is
  left out rather than guessed.

- **Follow-up questions under every answer, like Perplexity's "Related".**
  `parseAnswer` in `src/answer.ts` takes the ```followups block out of the
  reply (an array of up to three non-empty strings; anything else yields no
  buttons rather than a broken one) and `FollowUps` in
  `src/components/ChatPanel.tsx` lists them under the SQL inspector, one
  question per row with an arrow. A click sends the question as written through
  the new `onAsk` prop, which `App.tsx` wires to `submit`; the rows are disabled
  while another answer is in flight. Saved chats show them too, since the block
  is stored with the answer.

- **Answers now appear word by word, like ChatGPT.** `submit` in `src/App.tsx`
  calls the new `askStream` in `src/api.ts`, which reads
  `POST /agent/ask/stream` with `fetch` (EventSource can only GET and cannot
  send the bearer token). `Pending` in `src/components/ChatPanel.tsx` keeps a
  small spinner and a one-line status **above** the text for the whole wait:
  rotating placeholders ("Thinking…", "Finding the right data…") before the
  first step, then the step the server reports ("Running the query…") with the
  model's intent under it, then "Writing the answer…". Everything written so far
  stays **below** it: text the server marks as a step (`reset`) is kept on
  screen rather than cleared, so a sentence about the date range no longer
  disappears when the next query starts. The final answer replaces it all. The
  progress bar is gone. Text is revealed at a steady pace (`useSteadyReveal`:
  a few characters per frame, faster the further behind it is) so the bursts
  it arrives in read as typing rather than stutter; step text is shown quieter
  than the answer being written. The thread follows the answer only while the
  reader is at the bottom, so scrolling up to re-read is not undone on every
  frame. A half-written chart fence is hidden, updates are painted once per
  animation frame, and the finished answer, chart, SQL
  inspector and the recovery after a dropped connection are unchanged: a stream
  that ends without `done` is treated as a lost connection.

### Fixed

- **Saved answers no longer render DeepSeek tool-call markup as text.**
  `parseAnswer` in `src/answer.ts` cuts `<｜DSML｜…` markup from the answer. The
  service strips it from new answers; this covers ones saved before that.

- **A highlighted follow-up is always shown.** `takeFollowups` in
  `src/answer.ts` marks the last question as the insight when an answer has
  none marked (older saved answers, or the model forgot), so the "Get insights"
  card appears under every answer with follow-ups.


- **Text written between queries is shown as answer text, not muted.** The
  service now keeps that text in the final answer (a list the model wrote before
  checking one more thing used to vanish when the answer landed), so `.live-step`
  in `src/styles.css` no longer greys it out while it streams.


- **The tab no longer crashes ("Aw, Snap!", error code 5) while an answer
  streams in.** `Markdown` in `src/components/Markdown.tsx` never consumed a
  line that starts with `|` unless a table separator followed it: the table
  branch needs the separator, and the paragraph loop refuses pipe lines, so
  `i` never advanced and the render loop ran forever. A finished answer always
  had the separator; a streaming one shows the table header a frame before
  it. The paragraph now takes such a line as text. Checked by rendering every
  prefix of an answer with a table, list, quote, heading and stray pipe.

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
