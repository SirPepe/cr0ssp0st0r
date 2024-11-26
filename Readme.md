# cr0ssp0st0r

Minimum-effort script for cross-posting from Mastodon to Bluesky. Expecting that
Bluesky will, like all VC-funded projects, be enshittified and/or shut down in
short order, this script is devoid of any attempts at anything beyond "it kindof
works".

## Usage

Download `index.js`, set up environment variables, deploy in some fashion. Be
sure to make the storage directory persistent, otherwise threads won't work
right.

## What works

- Non-private, non-muted posts containing no mentions get posted to Bluesky. Post length is truncated properly when needed (with a link to the original Mastodon post).
- Images get transloaded from Mastodon to Bluesky and properly embedded in posts, with alt text and all other bells and whistles
- Cards get translated (and thumbnails transloaded) from Mastodon to Bluesky
- Posting threads

## What should be made to work

- OAuth for Bluesky
- Video embeds
- Stability

## Stretch goals

- A way to notify about failures (beyond screaming into the void that is stderr)
- Delay cross-posting every message for a minute or so to reflect immediate deletion from Mastodon
- Posting to other services (eg. Threads)
- Maybe have some sort of table that maps Mastodon handles to Bluesky handles so that at least _some_ mentions can work?
