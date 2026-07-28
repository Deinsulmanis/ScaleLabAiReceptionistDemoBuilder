#!/usr/bin/env node
/**
 * generate-demo-audio.js
 *
 * Generates TTS demo audio + synced timings JSON for each niche demo.
 *
 * Usage:
 *   node generate-demo-audio.js            # generates all demos in DEMOS
 *   node generate-demo-audio.js dental     # dental only
 *
 * Requires .env:
 *   ELEVENLABS_API_KEY=your_key_here
 *   VERONICA_VOICE_ID=your_veronica_voice_id_here
 *
 * To add a new vertical: add an entry to DEMOS (and CONVERSATION_* array).
 * Primary concat: ffmpeg via filter_complex (adds 0.4s silence gaps).
 * Fallback:       binary MP3 concat, 0-gap timings, console warning.
 *
 * Node >= 18 required (built-in fetch).
 */

'use strict';
require('dotenv').config();

const fs                        = require('fs');
const path                      = require('path');
const os                        = require('os');
const { execSync, spawnSync }   = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────────────

const API_KEY  = process.env.ELEVENLABS_API_KEY;
const EL_MODEL = 'eleven_turbo_v2_5';
const GAP_S    = 0.4;  // silence gap between lines when ffmpeg is available

// Default voice pair, used by any demo that doesn't declare its own `voices`.
// Keyed by the speaker field in the conversation arrays.
const DEFAULT_VOICES = {
  veronica: process.env.VERONICA_VOICE_ID,   // the AI receptionist
  caller:   '8DzKSPdgEQPaK5vKG0Rs',
};

if (!API_KEY) { console.error('[ERROR] ELEVENLABS_API_KEY missing from .env'); process.exit(1); }

// ─── Conversations ────────────────────────────────────────────────────────────

const CONVERSATION_DENTAL = [
  { speaker: 'caller',   text: "Hi, I'm looking for a new dentist — do you guys take new patients?" },
  { speaker: 'veronica', text: "We do! We're taking new patients right now. Are you looking for a general cleaning and checkup, or is there something specific bothering you?" },
  { speaker: 'caller',   text: "Bit of both honestly. I haven't been in about three years and one of my molars has been sensitive to cold." },
  { speaker: 'veronica', text: "Okay, that's helpful. Sensitivity like that is worth having the dentist look at — it could be a few different things. I'd book you for a new patient exam with x-rays so they can see what's going on, and we can do the cleaning at the same visit." },
  { speaker: 'caller',   text: "How much is that going to run me? I don't have insurance right now." },
  { speaker: 'veronica', text: "I can't quote you an exact number without the dentist seeing you, but I can tell you the new patient exam and x-rays are a set fee, and the office does offer payment plans if the treatment ends up being more involved. The front desk can walk you through the exact pricing when you come in." },
  { speaker: 'caller',   text: "Wait — am I talking to a person right now, or is this some kind of AI?" },
  { speaker: 'veronica', text: "I'm an AI assistant — I handle calls so nobody gets sent to voicemail. If you'd rather speak with someone from the team, I can take your number and have them call you back first thing. Whatever's easier for you." },
  { speaker: 'caller',   text: "No, it's fine, you're actually pretty easy to deal with. What have you got available?" },
  { speaker: 'veronica', text: "I've got Thursday at 2:40, or Friday morning at 9:15. Both are with Dr. Chen. Which works better?" },
  { speaker: 'caller',   text: "Friday morning works. But if the sensitivity gets worse before then, can I get in sooner?" },
  { speaker: 'veronica', text: "Absolutely — if it starts to hurt more, call back and let us know it's urgent. We keep same-day slots open for that. Can I get your name and a good number for the confirmation?" },
  { speaker: 'caller',   text: "Yeah, it's Sarah Mitchell — 604-555-0182." },
  { speaker: 'veronica', text: "Perfect, thanks Sarah. You're booked for Friday at 9:15 with Dr. Chen — new patient exam, x-rays and cleaning. I'll text you a confirmation right now, and you'll get a reminder the day before. See you Friday!" },
];

// Uncomment to regenerate the med spa demo:
// const CONVERSATION_MEDSPA = [
//   { speaker: 'caller',   text: "Hi, I saw your ad online — I'm looking into Botox and wanted to ask a couple things before booking." },
//   ... (14 lines)
// ];

// ── Custom demos: City Centre Dentistry (Surrey) ─────────────────────────────
// Lead-specific, built from scripts supplied verbatim. `veronica` is the
// speaker key for the AI receptionist — see the note in DEMOS below; the key
// name, not the voice ID, is what the proposal page keys its labels off.

// Same two pronunciation controls as the cosmetic script above — "Dr. Mannd"
// with the double n, and the phone number spelled out as words. Both demos run
// side by side on the same page, so the name has to sound identical in each.
const CONVERSATION_CITYCENTRE_EMERGENCY = [
  { speaker: 'veronica', text: "Thanks for calling City Centre Dentistry, Dr. Mannd's office — this is the front desk. How can I help you today?" },
  { speaker: 'caller',   text: "Hi — I think I might have a dental emergency? I chipped a tooth pretty badly this morning and it's really hurting." },
  // Opened with "Oh no — " originally. Cut: the receptionist should move
  // straight to handling it once the caller has explained the problem.
  { speaker: 'veronica', text: "I'm sorry to hear that, let's get you looked after right away. A chipped tooth with pain is something we treat as urgent, so I'm going to flag this for the team immediately. Can I get your name and a number to reach you?" },
  { speaker: 'caller',   text: "Yeah, it's Sam Carter — six oh four, five five five, oh one eight eight." },
  { speaker: 'veronica', text: "Thank you, Sam. I've flagged this as an emergency and I'm notifying Dr. Mannd's team right now so someone can get you seen as soon as possible today. In the meantime, if the pain worsens or you notice any swelling, please don't wait — let us know. Someone will be calling you back within a few minutes. Hang in there, okay?" },
  { speaker: 'caller',   text: "Okay, thank you so much." },
  // Was "Of course, Sam — help's on the way." — that reads as emergency
  // services dispatch, not a dental front desk. Same warmth, no 911 framing.
  { speaker: 'veronica', text: "Of course, Sam — talk to you very soon." },
];

// WARNING — the shipped demo-citycentre-emergency.mp3 is NOT a plain output of
// this script. The generated take had 4.03s of dead air inside turn 2, which
// was cut by hand, and the closing turn was trimmed off the end. The timings
// JSON was then rebuilt from the edited audio, not from clip durations.
// Re-running `node generate-demo-audio.js citycentre-emergency` WILL overwrite
// both files with a fresh TTS take that does not contain those edits — and TTS
// is non-deterministic, so the dead air may or may not come back. Listen before
// shipping any regenerated version.

// Revised take. Two deliberate spellings here are pronunciation controls for
// the TTS, not typos — do not "correct" them:
//   "Dr. Mannd"  — the double n stops the voice clipping the name short.
//   the phone number is spelled out as words ("six oh four, five five five...")
//   rather than digits, which the voice otherwise reads as "six hundred four".
// Caller turns are also longer and less clipped than the first take.
const CONVERSATION_CITYCENTRE_COSMETIC = [
  { speaker: 'veronica', text: "Thanks for calling City Centre Dentistry, Dr. Mannd's office — this is the front desk. How can I help you today?" },
  { speaker: 'caller',   text: "Hi there — so I've been thinking about getting Botox for a little while now, and honestly maybe Invisalign too somewhere down the road. I just wasn't sure what something like that usually costs, so I figured I'd call and ask before I got too far ahead of myself." },
  { speaker: 'veronica', text: "Absolutely — those are two of the things Dr. Mannd does a lot of here at City Centre, so you've definitely called the right place. Pricing really depends on your specific situation, so rather than give you a number that might be off, what we do is a free consultation — Dr. Mannd takes a look, walks you through your options for both the Botox and the Invisalign, and gives you an exact estimate right there. No cost, no obligation at all. Would you like me to get that booked for you?" },
  { speaker: 'caller',   text: "Oh, it's actually free? That's great, yeah — I'd definitely like to come in for that. I didn't realize the consultation wouldn't cost anything, so that makes it a lot easier to just come check it out." },
  { speaker: 'veronica', text: "Of course — no pressure at all, it's just a chance to get your questions answered. Have you seen Dr. Mannd before, or would this be your first time visiting City Centre?" },
  { speaker: 'caller',   text: "No, this would be my very first time — I've actually been looking for a new place for a while, so hopefully this works out." },
  { speaker: 'veronica', text: "Well, welcome — I think you'll really like it here. I'll get you set up as a new patient so everything's ready when you arrive. Can I start with your first and last name?" },
  { speaker: 'caller',   text: "Yeah, for sure — it's Jordan Lee." },
  { speaker: 'veronica', text: "Thanks, Jordan. And what's the best phone number to reach you at, just in case we need to confirm anything before your visit?" },
  { speaker: 'caller',   text: "Yeah, no problem — it's six oh four, five five five, oh one four two." },
  { speaker: 'veronica', text: "Perfect, got it. Dr. Mannd has a free consultation opening this Thursday at 2:30, or Friday morning at 10 — would either of those work for you?" },
  { speaker: 'caller',   text: "Um, Thursday at 2:30 would be great actually — that works really well with my schedule." },
  { speaker: 'veronica', text: "Wonderful — you're all set, Jordan. Thursday at 2:30 with Dr. Mannd for a free consult on the Botox and Invisalign, and I've got you in our system as a new patient. We'll send you a text reminder the day before so you don't have to think about it. Is there anything else I can help you with?" },
  { speaker: 'caller',   text: "No, that's everything — thank you so much, I really appreciate your help." },
  { speaker: 'veronica', text: "My pleasure, Jordan — we're looking forward to seeing you Thursday. Take care now!" },
];

// Voice pair for the City Centre demos, supplied for this lead.
const VOICES_CITYCENTRE = {
  veronica: 'xYa75LlayhWHCRl1yJSH',   // receptionist / the AI
  caller:   '3T3dPoABJjGZZAI1eif7',   // caller
};

// ─── Demo config — add new verticals here ────────────────────────────────────

// NOTE on the `veronica` speaker key: it is the AI-receptionist ROLE, not the
// voice. index.html labels bubbles with
//   ln.speaker === 'veronica' ? 'Veronica · AI Receptionist' : 'Caller'
// so a conversation must use exactly 'veronica' / 'caller' to render correctly,
// regardless of which voice ID actually speaks the lines. Renaming the key to
// 'receptionist' would silently label those bubbles "Caller".
const DEMOS = {
  dental: {
    conversation: CONVERSATION_DENTAL,
    output:       path.join(__dirname, 'audio', 'demo-dental.mp3'),
    timingsOut:   path.join(__dirname, 'audio', 'demo-dental-timings.json'),
    audioRef:     'demo-dental.mp3',
  },

  'citycentre-emergency': {
    conversation: CONVERSATION_CITYCENTRE_EMERGENCY,
    voices:       VOICES_CITYCENTRE,
    output:       path.join(__dirname, 'audio', 'demo-citycentre-emergency.mp3'),
    timingsOut:   path.join(__dirname, 'audio', 'demo-citycentre-emergency-timings.json'),
    audioRef:     'demo-citycentre-emergency.mp3',
  },

  'citycentre-cosmetic': {
    conversation: CONVERSATION_CITYCENTRE_COSMETIC,
    voices:       VOICES_CITYCENTRE,
    output:       path.join(__dirname, 'audio', 'demo-citycentre-cosmetic.mp3'),
    timingsOut:   path.join(__dirname, 'audio', 'demo-citycentre-cosmetic-timings.json'),
    audioRef:     'demo-citycentre-cosmetic.mp3',
  },
  // medspa: {
  //   conversation: CONVERSATION_MEDSPA,
  //   output:       path.join(__dirname, 'audio', 'demo-audio.mp3'),
  //   timingsOut:   path.join(__dirname, 'audio', 'demo-timings.json'),
  //   audioRef:     'demo-audio.mp3',
  // },
};

// ─── ElevenLabs TTS ───────────────────────────────────────────────────────────

async function synthesizeLine(text, voiceId) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key':   API_KEY,
      'Content-Type': 'application/json',
      'Accept':       'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id:       EL_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs HTTP ${res.status}: ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ─── Duration parsing ─────────────────────────────────────────────────────────

// Measures the DECODED length of a clip file with ffprobe.
//
// This must not use the MP3 header (music-metadata et al): ffmpeg's concat
// filter decodes every input to PCM and joins the samples, so what lands in the
// output is the decoded length, which differs from the header estimate by the
// encoder delay/padding on each clip. Header-based measurement made the timings
// run ~0.6% long, and because the error is per-clip it accumulated — the last
// transcript bubble in a 15-line demo fired ~0.6s before the audio reached it.
async function getClipDuration(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ], { encoding: 'utf8' });

  const d = parseFloat((r.stdout || '').trim());
  if (r.status === 0 && isFinite(d) && d > 0) return d;

  // Fallback if ffprobe is unavailable: header estimate, drift and all.
  try {
    const mm   = require('music-metadata');
    const meta = await mm.parseBuffer(fs.readFileSync(file), { mimeType: 'audio/mpeg' });
    if (meta.format.duration > 0) return meta.format.duration;
  } catch (_) {}
  return fs.statSync(file).size / 16000;
}

// ─── Concat with ffmpeg ───────────────────────────────────────────────────────

function ffmpegAvailable() {
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}

// Run ffmpeg with args as an array — avoids shell quoting issues on Windows.
function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').slice(-1000);
    throw new Error(`ffmpeg exited ${result.status}:\n${msg}`);
  }
}

async function concatWithFfmpeg(clipPaths, gapS, outputPath) {
  const tmpDir      = fs.mkdtempSync(path.join(os.tmpdir(), 'scalelabdemo-'));
  const silencePath = path.join(tmpDir, 'silence.mp3');

  try {
    // Generate a 0.4s silence clip (used as gap between spoken lines)
    runFfmpeg([
      '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-t', String(gapS), '-c:a', 'libmp3lame', '-q:a', '9', silencePath,
    ]);

    // Build interleaved input list: clip0, silence, clip1, silence, ..., clipN
    const parts = [];
    clipPaths.forEach((f, i) => {
      parts.push(f);
      if (i < clipPaths.length - 1) parts.push(silencePath);
    });

    // filter_complex concat — avoids shell-quoting issues with path demuxer on Windows
    const streams = parts.map((_, i) => `[${i}:a]`).join('');
    const filter  = `${streams}concat=n=${parts.length}:v=0:a=1[out]`;
    const iArgs   = parts.flatMap(f => ['-i', f]);

    runFfmpeg([
      '-y', ...iArgs,
      '-filter_complex', filter,
      '-map', '[out]',
      '-c:a', 'libmp3lame', '-b:a', '128k',
      outputPath,
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Generate one demo ────────────────────────────────────────────────────────

async function generateDemo(name, config) {
  const { conversation, output, timingsOut, audioRef } = config;
  const voices    = config.voices || DEFAULT_VOICES;
  const useFfmpeg = ffmpegAvailable();

  if (!useFfmpeg) {
    console.warn('[WARN] ffmpeg not found on PATH — using binary concat (no silence between lines).');
    console.warn('[WARN] Install ffmpeg for natural conversational pauses in the audio.');
  }

  const gap = useFfmpeg ? GAP_S : 0;
  console.log(`\n[${name}] Synthesising ${conversation.length} lines...`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `scalelabdemo-${name}-`));

  try {
    const clipPaths   = [];
    const clipBuffers = [];
    const durations   = [];

    for (let i = 0; i < conversation.length; i++) {
      const { speaker, text } = conversation[i];
      const voiceId = voices[speaker];
      if (!voiceId) throw new Error(`No voice ID configured for speaker "${speaker}" in demo "${name}"`);
      const preview = text.length > 52 ? text.slice(0, 52) + '…' : text;
      process.stdout.write(`  [${String(i + 1).padStart(2)}/${conversation.length}] ${speaker.padEnd(9)} ${voiceId.slice(0, 8)}… ${preview} `);

      const buf  = await synthesizeLine(text, voiceId);
      const file = path.join(tmpDir, `clip_${String(i).padStart(3, '0')}.mp3`);
      fs.writeFileSync(file, buf);
      const dur = await getClipDuration(file);   // decoded length, see note above

      clipPaths.push(file);
      clipBuffers.push(buf);
      durations.push(dur);
      console.log(`→ ${dur.toFixed(3)}s`);
    }

    // Stitch audio
    if (useFfmpeg) {
      console.log(`\n[${name}] Concatenating with ${gap}s gaps via ffmpeg...`);
      await concatWithFfmpeg(clipPaths, gap, output);
    } else {
      console.log(`\n[${name}] Binary concat (0-gap)...`);
      fs.writeFileSync(output, Buffer.concat(clipBuffers));
    }

    // Build timings (same format as demo-timings.json)
    let cursor = 0;
    const lines = conversation.map((line, i) => {
      const start = parseFloat(cursor.toFixed(3));
      const end   = parseFloat((cursor + durations[i]).toFixed(3));
      cursor      = parseFloat((end + gap).toFixed(3));
      return { index: i, speaker: line.speaker, text: line.text, start, end };
    });

    const totalDuration = parseFloat((cursor - gap).toFixed(3));
    const timings       = { audio: audioRef, totalDuration, lines };

    // Optional per-demo transcript labels. Omitted by default: the page already
    // defaults the `veronica` key to "AI Receptionist", so only a demo that
    // wants a *named* persona needs to emit this.
    if (config.speakerLabels) timings.speakerLabels = config.speakerLabels;

    fs.writeFileSync(timingsOut, JSON.stringify(timings, null, 2));

    console.log(`\n[${name}] Done.`);
    console.log(`  audio:    ${output}`);
    console.log(`  timings:  ${timingsOut}`);
    console.log(`  duration: ${totalDuration}s  (${Math.floor(totalDuration / 60)}:${String(Math.round(totalDuration % 60)).padStart(2, '0')})`);
    console.log(`  lines:    ${lines.length}`);

    return { name, totalDuration, lineCount: lines.length };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const target = process.argv[2];
  const toRun  = target
    ? (DEMOS[target] ? { [target]: DEMOS[target] } : null)
    : DEMOS;

  if (!toRun) {
    console.error(`[ERROR] Unknown demo "${target}". Available: ${Object.keys(DEMOS).join(', ')}`);
    process.exit(1);
  }

  const results = [];
  for (const [name, config] of Object.entries(toRun)) {
    results.push(await generateDemo(name, config));
  }

  console.log('\n── Summary ─────────────────────────────────');
  results.forEach(r => console.log(`  ${r.name}: ${r.totalDuration}s, ${r.lineCount} lines`));
}

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
