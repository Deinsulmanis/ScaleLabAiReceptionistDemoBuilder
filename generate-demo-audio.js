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
 * Primary concat: fluent-ffmpeg + ffmpeg binary on PATH (adds 0.4s silence gaps).
 * Fallback:       binary MP3 concat, 0-gap timings, console warning.
 *
 * Node >= 18 required (built-in fetch).
 */

'use strict';
require('dotenv').config();

const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { execSync } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────────────

const API_KEY        = process.env.ELEVENLABS_API_KEY;
const VOICE_CALLER   = '8DzKSPdgEQPaK5vKG0Rs';
const VOICE_VERONICA = process.env.VERONICA_VOICE_ID;
const EL_MODEL       = 'eleven_turbo_v2_5';
const GAP_S          = 0.4;  // silence gap between lines when ffmpeg is available

if (!API_KEY)        { console.error('[ERROR] ELEVENLABS_API_KEY missing from .env'); process.exit(1); }
if (!VOICE_VERONICA) { console.error('[ERROR] VERONICA_VOICE_ID missing from .env');  process.exit(1); }

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

// ─── Demo config — add new verticals here ────────────────────────────────────

const DEMOS = {
  dental: {
    conversation: CONVERSATION_DENTAL,
    output:       path.join(__dirname, 'audio', 'demo-dental.mp3'),
    timingsOut:   path.join(__dirname, 'audio', 'demo-dental-timings.json'),
    audioRef:     'demo-dental.mp3',
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

async function getBufferDuration(buf) {
  try {
    const mm   = require('music-metadata');
    const meta = await mm.parseBuffer(buf, { mimeType: 'audio/mpeg' });
    if (meta.format.duration > 0) return meta.format.duration;
  } catch (_) {}
  // Rough fallback: assumes ~128 kbps
  return buf.length / 16000;
}

// ─── Concat with ffmpeg ───────────────────────────────────────────────────────

function ffmpegAvailable() {
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}

async function concatWithFfmpeg(clipPaths, gapS, outputPath) {
  const tmpDir      = fs.mkdtempSync(path.join(os.tmpdir(), 'scalelabdemo-'));
  const silencePath = path.join(tmpDir, 'silence.mp3').replace(/\\/g, '/');
  const listPath    = path.join(tmpDir, 'list.txt');

  try {
    // Generate a silence clip for the gap
    execSync(
      `ffmpeg -y -f lavfi -i "anullsrc=r=44100:cl=mono" -t ${gapS} -c:a libmp3lame -q:a 9 "${silencePath}"`,
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );

    // Build concat list: clip, silence, clip, silence, ..., clip
    const entries = [];
    clipPaths.forEach((f, i) => {
      entries.push(`file "${f.replace(/\\/g, '/')}"`);
      if (i < clipPaths.length - 1) entries.push(`file "${silencePath}"`);
    });
    fs.writeFileSync(listPath, entries.join('\n'));

    const outNorm = outputPath.replace(/\\/g, '/');
    execSync(
      `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c:a libmp3lame -b:a 128k "${outNorm}"`,
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Generate one demo ────────────────────────────────────────────────────────

async function generateDemo(name, config) {
  const { conversation, output, timingsOut, audioRef } = config;
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
      const voiceId = speaker === 'veronica' ? VOICE_VERONICA : VOICE_CALLER;
      const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
      process.stdout.write(`  [${String(i + 1).padStart(2)}/${conversation.length}] ${speaker.padEnd(8)} ${preview} `);

      const buf  = await synthesizeLine(text, voiceId);
      const dur  = await getBufferDuration(buf);
      const file = path.join(tmpDir, `clip_${String(i).padStart(3, '0')}.mp3`);
      fs.writeFileSync(file, buf);

      clipPaths.push(file);
      clipBuffers.push(buf);
      durations.push(dur);
      console.log(`→ ${dur.toFixed(3)}s`);
    }

    // Stitch audio
    if (useFfmpeg) {
      console.log(`\n[${name}] Concatenating with ${gap}s gaps via ffmpeg…`);
      await concatWithFfmpeg(clipPaths, gap, output);
    } else {
      console.log(`\n[${name}] Binary concat (0-gap)…`);
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
    fs.writeFileSync(timingsOut, JSON.stringify(timings, null, 2));

    console.log(`\n[${name}] ✓ Done`);
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

  console.log('\n── Summary ──────────────────────────────');
  results.forEach(r => console.log(`  ${r.name}: ${r.totalDuration}s, ${r.lineCount} lines`));
}

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
