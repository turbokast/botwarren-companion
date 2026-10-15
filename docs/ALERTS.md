# Phone alerts: "An agent is waiting for you"

Status: designed and built for version 0.1.2. Protocol details: [PROTOCOL.md](PROTOCOL.md) (kinds `push` and `pushack`, the replace key, the relay's `push` message). Licence of this document and the code it describes: Apache-2.0.

## The problem

In 0.1.0 and 0.1.1 the phone page showed a waiting request only while it was open. A person who put the phone down was never told. An alert has to reach a locked phone, so it has to travel through a **push service** (Google, Apple, Mozilla or Microsoft run one for each browser), and it has to do that without giving the relay, Botwarren's website or the push service anything about the agent: no tool, command, project or session text. They must stay unable to read content.

## What the person sees

A notification that says **"An agent is waiting for you"**, and nothing else. Tapping it opens the phone page straight on that request (or on the list when several are waiting). If the request has been answered or has expired meanwhile, the page says exactly that. Settings: an **Alerts on/off** switch on the phone page (gear icon, and a one-time offer on the home screen), and on the computer `botwarren-companion alerts` (master switch, finished turns, quiet hours).

## Design chosen: the phone page registers its own push subscription; the computer seals every alert and asks the relay only to deliver the ciphertext

```
phone page ──(E2EE `push` message with its Web Push subscription)──▶ your computer
your computer: a request starts waiting → seals {"v":1,"k":"waiting","r":<random request id>} with RFC 8291 for THAT phone's keys
your computer ──(relay control message: endpoint + ciphertext, at most 600 bytes)──▶ relay ──(VAPID-signed POST)──▶ push service ──▶ phone's service worker
service worker: shows fixed words; tap opens the page on request `r`
```

* **The subscription travels inside the end-to-end encrypted channel.** The two keys that let anyone seal a message for the phone (`p256dh`, `auth`) never reach the relay or botwarren.com. The relay learns only the push endpoint URL, at the moment an alert is delivered (an opaque address at the push service, which the push service itself assigned).
* **The computer seals the alert.** The relay cannot read it and **cannot write one the phone would accept**: without `p256dh` and `auth` it can only replay or withhold. The push service gets ciphertext it cannot open. The payload has exactly three fields; the strict schema (`AlertPayload`) rejects anything else, and the relay refuses a body over 600 bytes (an alert is about 170), so there is no room for content even from a modified companion.
* **The words are not in the payload.** The service worker shows fixed text whatever the payload says (tested with forged payloads). The only thing it takes from the payload is the random request id, and only if it matches `^[a-z0-9-]{4,40}$`.
* **botwarren.com is not involved at all.** It never learns that an agent is waiting.

### Why not option (b): trigger botwarren.com's existing push feature

Botwarren already has Web Push for ships (owner-only subscriptions, VAPID keys). Reusing it would mean the computer tells botwarren.com "a companion session is waiting" and the notification deep-links to the relay page. It was rejected because:

1. **It would give the website a new live signal about the user's agents** (when a session waits, from which account), which today it does not have for companion sessions, and put a new host-to-website channel in the path. The point of the companion is that botwarren.com is outside the circle of trust for anything about the agents. With the chosen design the only parties that see anything see only a delivery request and its timing.
2. **The two web pages are different origins.** A subscription made on `botwarren.com` is delivered to that origin's service worker; its notification would open botwarren.com, which would then have to send the person on to the relay origin. On iPhone, where Web Push exists only for a site added to the Home Screen, that means *two* Home Screen apps and a hop between them. With the chosen design the page that shows the request is the page that owns the subscription: the notification opens it directly.
3. **The ship feature is derived from public, delayed ship events** (settle time plus the publish delay), which suits a public ship and not a request someone is waiting on.

The cost of the chosen design is that the relay holds one more secret (its own VAPID key pair; compromise lets an attacker who also knows a subscription's endpoint send that phone *undecryptable* pushes, which show nothing) and a little code (about 100 lines of delivery and rate limiting). It does not hold any key that can read or forge an alert.

## What each party can see

| Party | Sees | Cannot see |
|---|---|---|
| Your computer | everything (it is yours) | n/a |
| The relay | that a host asked for a delivery, when, to which push endpoint URL, and the size of the sealed body (under 600 bytes) | the alert's content (a random request id and the word "waiting"), the phone's keys, any agent information |
| The push service (Google, Apple, Mozilla, Microsoft) | that a message was delivered to that endpoint, when, with TTL, urgency and the topic `bw-waiting`; its size | the content (sealed with the phone's keys) |
| botwarren.com | nothing (it is not in the path) | everything |
| The phone's lock screen | "Botwarren: An agent is waiting for you" | tool, command, project, session |

Timing is the residual leak: the relay and the push service can see **when** an agent started waiting. The relay already sees when frames flow between your computer and your phone, so this adds the push service as a second party that sees a timestamp. It is accepted and stated on the trust page.

## Rules that keep it quiet (computer side, `src/alerts.ts`)

* **One alert per waiting episode** (one pending request). A new request is a new episode.
* **Settle time** (`delaySeconds`, default 15): nothing is sent until the request has been waiting that long; someone at the keyboard usually answers within seconds.
* **Quiet after an answer:** an episode that was answered, replaced or expired is forgotten at once; an alert held back (by the gap, quiet hours or the cap) is never sent for it.
* **Coalescing:** one alert covers everything waiting at that moment; the next one waits `minGapSeconds` (default 60). The tap opens the request only when exactly one is waiting, otherwise the list.
* **Caps:** at most `maxPerHour` (default 12) alerts per hour from the computer; the relay also limits each host (a burst of 5, one more per 30 seconds, at most 30 an hour) and each account.
* **Quiet hours** (this computer's clock; `botwarren-companion alerts quiet 22:00-07:00`) hold alerts back; after they end an alert is sent only if something is still waiting.
* **Pause and the master switch** send nothing (`botwarren-companion pause`, `botwarren-companion alerts off`). The phone's own Alerts switch removes its subscription from the computer.
* **Finished turns** (an agent that finished and waits for its next instruction) do not alert unless asked for (`botwarren-companion alerts idle on`): it happens after every turn.
* **Push TTL 10 minutes, urgency high, topic `bw-waiting`:** a stale "waiting" is worthless, and a newer alert replaces one still queued at the push service.
* While the phone page is open and visible the worker shows nothing (the page shows the request itself), except in Safari, which revokes the permission of a site that receives a push and shows nothing.

There is no per-project mute in the companion (the ship feature has them for ships). Pausing, the master switch, quiet hours and the phone's own switch are the controls.

## Browser rules the page keeps to

* The permission prompt is the first thing a tap does (iOS ties it to the tap) and it is never asked on page load.
* **iPhone and iPad:** Web Push exists only for a page added to the Home Screen (iOS 16.4 and later). In a Safari tab the page says so instead of offering a dead button: add it to the Home Screen, open it from there, **pair again there** (a Home Screen app has its own storage, separate from the Safari tab), and turn alerts on. Alerts then work with the phone locked.
* Android (Chrome, Firefox, Samsung Internet) and desktop browsers work in a normal tab.
* If the browser rotates the subscription, the page sends the new one to the computer every time it connects while alerts are on. A subscription the push service reports gone (404 or 410) is dropped by the computer.

## The service worker: what it is allowed to be

0.1.0 shipped no service worker on purpose: a worker is persistent code served by the relay's origin, and one that intercepts requests could outlive a fix. The alert worker (`client/static/sw.js`, about 50 lines) is built so that it cannot do that:

* It registers handlers for `install`, `activate`, `push` and `notificationclick` only: **no handler for network requests**, so it never sits between the page and the network and cannot change what the page loads (a test fails if one is added).
* Its bytes are listed with a SHA-256 in the **signed client manifest**; the page fetches `sw.js`, compares it with the signed hash and **refuses to register a different copy** (tested with a tampered file). The release verification checks it like every other client file.
* A malicious relay could still serve a different worker on a later update check, exactly as it could serve a different page: this is the same accepted residual risk as the web client itself ([CLIENT_SECURITY.md](CLIENT_SECURITY.md) 1.4), no larger. Browsers re-check a worker's script at least every 24 hours, and the page's scope is the relay's own cookie-less origin.

## Operating it (the relay)

The relay offers alerts only if it has its own VAPID key pair (`RELAY_VAPID_PUBLIC_KEY`, `RELAY_VAPID_PRIVATE_KEY`, optional `RELAY_VAPID_SUBJECT`): see [RELAY.md](RELAY.md). Generate it **once**: a different key invalidates every phone's subscription (they must turn alerts off and on again). Without the pair the page does not offer alerts and says so. `POST /admin/push {"on":false}` switches alerts off at once without touching the secrets. The relay counts outcomes under fixed codes (`push_sent`, `push_gone`, `push_rate_limited`, ...) and never logs an endpoint or a body; a test plants canaries and finds none.
