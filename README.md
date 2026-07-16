# Auto Depot Russellville — Inventory Feed

Generates a Meta Commerce Manager automotive inventory feed
(`docs/feed-russellville.xml`) from Auto Depot Russellville's public
inventory JSON endpoint. Same feed schema as the Fikes Chevrolet pipeline —
no Puppeteer needed here since the site exposes a plain JSON API.

Tuscaloosa is intentionally not part of this repo (only ~2 vehicles right
now — separate feed/repo when that lot is worth building for).

## Status: local build works, not yet live

### Done
- [x] Script rewritten for Russellville only (Tuscaloosa removed)
- [x] `package.json` + dependencies set up
- [x] Field mapping confirmed against a live fetch of the endpoint (see
      comments at the top of `scraper.js` for the full confirmed field list)

### Still need (in rough order)

1. **Run `npm install` and a first live build** — hasn't been test-run yet
   from this machine. `npm run build` should produce `docs/feed-russellville.xml`
   and `docs/inventory-russellville.json`. Watch the console output for any
   `UNRESOLVED FIELD` warnings — the price/image field guesses were verified
   correct against Russellville's schema, but re-confirm nothing's drifted.

2. **Confirm the Meta Pixel ID** — `scraper.js` has
   `pixelId: 'TODO_CONFIRM_PIXEL_ID_RUSSELLVILLE'` as a placeholder. Zach
   mentioned a pixel "may already be built in" on the site but this was never
   verified. Check Events Manager for Auto Depot's Business Manager and drop
   the real ID in once confirmed. (This is just a comment in the XML output
   right now, not something the script depends on to run — but Commerce
   Manager will need the real pixel connected to the catalog before dynamic
   ads can track events back to it.)

3. **Business Manager / ad account access** — need to be added to whatever
   Business Manager owns Auto Depot's assets, or have their pixel/catalog
   shared to your Business Manager. This is a Zach/John conversation, not
   something the script touches.

4. **Set up hosting** — like the Fikes repo, this needs to live in an actual
   GitHub repo with GitHub Pages enabled so Commerce Manager can pull the
   feed from a stable URL. Not done yet — this project folder isn't a git
   repo yet.

5. **Create the Commerce Manager catalog** — new catalog (or product set)
   for Auto Depot Russellville, pointed at the hosted `feed-russellville.xml`
   URL once step 4 is done.

6. **Automation** — once this is confirmed working end-to-end, decide on a
   schedule (cron/launchd, same pattern as the Fikes Mac Mini job) — holding
   off on this deliberately until it's running from the machine that'll
   actually host the recurring job.

## Local setup

```bash
npm install
npm run build
```

Output lands in `docs/`:
- `feed-russellville.xml` — the Meta Commerce Manager feed
- `inventory-russellville.json` — full raw inventory snapshot, useful for
  debugging field mapping issues

## Files

- `scraper.js` — fetches, maps, and writes the feed
- `package.json` — dependencies (`fast-xml-parser` for feed validation)
