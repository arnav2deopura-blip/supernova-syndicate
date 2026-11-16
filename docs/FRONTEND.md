
## Interaction and performance audit (15 Nov)

See [acceptance audit](ACCEPTANCE_AUDIT.md) for purposes, failure conditions,
fixes, reproducible browser checks and deployment verification limits. Advanced
omits unavailable measurements and reports unavailable analyses concisely. Free
Explore selects actual regions and passes them to the same real-data search pipeline.


Layout and design follow FRONTEND_UPGRADE_PLAN (a measuring instrument): top bar with one
search field; context bar with the target, field of view, wavelength ruler (D1–D6) and the
provenance and comparison tags (inside `#badges`); the stage with corner readouts, scale bar,
compass, colour bar and a hatched no-data background; the time dock with passes as blocks on a
date axis; the inspector tabs Events, Spectrum and Details; the status bar. Chrome is neutral
grey: colour is reserved for the image, markers and charts (Okabe–Ito, a shape per kind). No
image assets beyond the picker thumbnails rendered from saved frames.

Play passes preserves distinct observations; Smooth is a labeled visual blend. Side by side
shares coordinate placement, zoom and stretch across A/B. All modes preserve the configured
backend in copied URLs. A channel range with a channel missing from any pass draws nothing
until the user chooses (a covered sub-range, the passes that have every channel, or the whole
band). For the saved test targets the movers search and light curve load immediately; for other
positions they wait for the Details tab.

The Backend only checkbox (status bar) sets strict `fresh=1` (`verify=1` is an alias): unavailable services produce explicit
errors, never a saved substitute. Test-target saved frames carry a processing manifest;
older optional science bakes are labeled historical. Opening Advanced marks each request
pending before submission, avoiding duplicate builds. Supplementary work resets when
centre, band or FOV changes. Colours and channel-range provenance come from their cube.

Response validation occurs before arrays are dereferenced. Frame/cube dimensions,
lengths, timestamps and pixels are validated; downloads and decoded arrays have caps.
Transfers and jobs have deadlines even without modern AbortSignal helpers. A job with no
progress for two minutes asks the user to keep waiting, retry or cancel; background jobs fail
after five minutes without progress, and no job is polled for more than twenty minutes. Job
status and result links must stay on the backend's origin. Busy (429) answers are retried after
their delay; a job the server forgot is resubmitted once.
