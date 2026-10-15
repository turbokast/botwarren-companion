/*
 * Botwarren Link: the alert service worker (Apache-2.0). It does two things and nothing else:
 *   1. when a push arrives it shows ONE notification with fixed words ("An agent is waiting for you"). The push is sealed by your own computer for this
 *      phone's keys; whatever it contains, this file never shows any of it. At most it reads a random request id so a tap can open that request.
 *   2. when the notification is tapped it opens (or focuses) this page, on that request.
 * It handles no network requests at all (no handler for them is registered): it never sits between the page and the network, so it cannot change what the page loads. Its bytes are listed, with a
 * SHA-256, in the signed manifest, and the page refuses to register a copy that does not match.
 */
'use strict';

var TITLE = 'Botwarren';
var BODY = 'An agent is waiting for you';
var RID = /^[a-z0-9-]{4,40}$/;
var TEST_BODY = 'Test alert: alerts work on this phone';
var TESTID = /^[A-Za-z0-9_-]{8,32}$/;

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

/** Safari (macOS and iOS) revokes the permission of a site that receives a push and shows nothing: there a notification is always shown */
function mustShow() {
  var ua = (self.navigator && self.navigator.userAgent) || '';
  return /Safari\//.test(ua) && !/Chrome|Chromium|Android|Edg\/|OPR\/|Firefox/.test(ua);
}

/** the phone's own "Send a test alert": returns its test id, or '' for anything else */
function testId(event) {
  try {
    var d = event.data ? event.data.json() : null;
    if (d && d.v === 1 && d.k === 'test' && typeof d.n === 'string' && TESTID.test(d.n)) return d.n;
  } catch (e) { /* not a test */ }
  return '';
}

function requestId(event) {
  try {
    var d = event.data ? event.data.json() : null;
    if (d && d.v === 1 && d.k === 'waiting' && typeof d.r === 'string' && RID.test(d.r)) return d.r;
  } catch (e) { /* not ours: fixed words anyway */ }
  return '';
}

self.addEventListener('push', function (event) {
  event.waitUntil((async function () {
    var test = testId(event);
    if (test) {
      // a test is always shown (the person is checking that notifications reach this phone), and the open page is told that it arrived
      var open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (var j = 0; j < open.length; j++) open[j].postMessage({ t: 'bw-test', n: test });
      await self.registration.showNotification(TITLE, { body: TEST_BODY, tag: 'bw-test', data: { rid: '' } });
      return;
    }
    var rid = requestId(event);
    var wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (var i = 0; i < wins.length; i++) wins[i].postMessage({ t: 'bw-waiting', rid: rid });
    // someone is looking at the page right now: it shows the request itself (except where the browser insists on a notification)
    if (!mustShow() && wins.some(function (c) { return c.visibilityState === 'visible'; })) return;
    await self.registration.showNotification(TITLE, { body: BODY, tag: 'bw-waiting', renotify: true, data: { rid: rid } });
  })());
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var d = event.notification.data;
  var rid = d && typeof d.rid === 'string' && RID.test(d.rid) ? d.rid : '';
  event.waitUntil((async function () {
    var wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (var i = 0; i < wins.length; i++) {
      if (typeof wins[i].focus === 'function') {
        try { await wins[i].focus(); } catch (e) { /* some browsers refuse; the message still moves the page */ }
        wins[i].postMessage({ t: 'bw-open', rid: rid });
        return;
      }
    }
    await self.clients.openWindow('./#/' + (rid ? 'r/' + rid : 'waiting'));
  })());
});
