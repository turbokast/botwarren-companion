/**
 * Plain text for a terminal-style view: what an agent printed with colours and cursor moves becomes the text a person would read. Used by the computer
 * before it seals a message (so what is approved is the cleaned text) and by the phone page for anything it shows. Pure; no DOM, no Node APIs.
 * Licence: Apache-2.0.
 */

/* eslint-disable no-control-regex */
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g; // colours, cursor moves, erase
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g; // window titles, hyperlinks
const ESC_OTHER = /\u001b[@-Z\\-_]|\u001b[()][0-9A-B]|\u001b[=>78c]/g; // two-character sequences, charset selection
const C1 = /[\u0080-\u009f]/g;
/** left-to-right and right-to-left overrides and isolates: they can make a command read differently from how it runs */
const BIDI = /[‪-‮⁦-⁩]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g; // everything but tab and newline (and the carriage return handled below)

export function cleanText(input: string): string {
  let s = input.replace(OSC, '').replace(CSI, '').replace(ESC_OTHER, '').replace(/\r\n/g, '\n');
  // a carriage return redraws the line (progress bars): what stays on screen is what was written last
  s = s.split('\n').map((line) => (line.includes('\r') ? (line.split('\r').filter((p) => p !== '').pop() ?? '') : line)).join('\n');
  return s.replace(C1, '').replace(BIDI, '').replace(CONTROL, '');
}
