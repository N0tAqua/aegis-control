# Project notes

## Feature page

`server/features-catalog.js` is the single source of truth for the public
`/features` page. Whenever a user-facing feature is added, changed or removed —
a bot command, a dashboard page, or a new tool — update the matching group and
card in that file in the same commit.

Keep each entry to a name, an optional command hint, and one short sentence that
says what the feature actually does for a server owner. Bump `FEATURES_UPDATED`
when the list changes. `/features` is rendered by `server/worker.js`, so no other
file needs editing for the page itself.
