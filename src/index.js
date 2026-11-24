'use strict'

// Competitor Radar — service entry.
//
// The scheduler now runs inside the dashboard process, so there is exactly one
// place that can send the daily email and schedule changes made in the UI take
// effect immediately. `npm start` and `npm run ui` are therefore the same
// thing: the dashboard on http://127.0.0.1:7070 with the cron armed.

require('./ui')
