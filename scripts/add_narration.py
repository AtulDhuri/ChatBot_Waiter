"""Add a spoken voice-over to demo-recording/dineos-owner-demo.webm.

Output: demo-recording/dineos-owner-demo-narrated.webm (original is untouched).
Uses edge-tts (neural voices, needs internet) and the ffmpeg bundled with imageio-ffmpeg.

    pip install edge-tts imageio-ffmpeg
    python scripts/add_narration.py
"""
import asyncio
import os
import re
import subprocess
import tempfile

import edge_tts
import imageio_ffmpeg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "demo-recording", "dineos-owner-demo.webm")
DST = os.path.join(ROOT, "demo-recording", "dineos-owner-demo-narrated.webm")
VOICE = "en-IN-NeerjaNeural"
SRT = os.path.join(ROOT, "demo-recording", "dineos-owner-demo-narrated.en.srt")
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

# (start second, latest end second, text) matched to the scenes in the video.
LINES = [
    (0.5, 7.8, "Meet DineOS. A waiter that never misses an order."),
    (8.5, 15.8, "Print one QR code for each table. Every code knows its table, so each order reaches the right place."),
    (16.5, 31.5, "Guests scan the code, browse your menu and tap to add dishes. "
                 "No app to download, and no waiting to catch a waiter's eye."),
    (32.5, 47.5, "Guests also get a built-in AI waiter. Questions about dishes are answered from your own menu, "
                 "so your staff can keep serving."),
    (48.5, 55.8, "They can even just type the order. Two masala chai please, and it goes straight into the order."),
    (56.5, 71.5, "Something ran out? Mark it sold out in one tap. It disappears from guests' orders automatically, "
                 "before it reaches the kitchen."),
    (72.5, 87.5, "Guests choose what comes first. Tea first, pizza after. "
                 "Your kitchen sees the same serving order on every ticket."),
    (88.5, 111.0, "Orders go straight to the kitchen. No paper slips, and no lost orders. "
                  "The ticket appears instantly, with the guest's notes."),
    (118.0, 151.5, "The kitchen moves each dish from accepted, to cooking, to ready, to served. "
                   "Guests watch every step live on their phone, so there are fewer, where is my food, questions."),
    (152.5, 166.0, "When they are done, guests get the bill in one tap, and a UPI QR code with the amount "
                   "already filled in. It works with GPay, PhonePe, Paytm and BHIM."),
    (167.0, 183.0, "The manager confirms the payment, and the table closes automatically "
                   "once everything is served and paid."),
    (184.5, 189.8, "Know your numbers. Sales, orders and best sellers, always up to date."),
    (190.5, 196.2, "Faster service, happier guests. Start taking orders today."),
]


def run(args):
    return subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error"] + args, check=True)


def duration(path):
    p = subprocess.run([FFMPEG, "-hide_banner", "-i", path], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", p.stderr)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def split_cues(text, start, end, max_chars=84):
    """Split a spoken line into subtitle cues, timed by character share."""
    parts = []
    for sent in re.split(r"(?<=[.?!])\s+", text.strip()):
        while len(sent) > max_chars:  # break long sentences at a comma or space
            cut = sent.rfind(",", 0, max_chars)
            cut = cut if cut > 20 else sent.rfind(" ", 0, max_chars)
            parts.append(sent[:cut + 1].strip())
            sent = sent[cut + 1:].strip()
        parts.append(sent)
    total = sum(len(p) for p in parts)
    out, t = [], start
    for p in parts:
        d = (end - start) * len(p) / total
        out.append((t, t + d, p))
        t += d
    return out


def stamp(s):
    ms = int(round(s * 1000))
    return "%02d:%02d:%02d,%03d" % (ms // 3600000, ms // 60000 % 60, ms // 1000 % 60, ms % 1000)


def write_srt(cues, path):
    with open(path, "w", encoding="utf-8") as f:
        for i, (a, b, p) in enumerate(cues, 1):
            f.write("%d\n%s --> %s\n%s\n\n" % (i, stamp(a), stamp(b), p))


async def synth(text, path):
    await edge_tts.Communicate(text, VOICE, rate="+8%").save(path)


def main():
    tmp = tempfile.mkdtemp(prefix="dineos-voice-")
    inputs, filters, labels, too_long, cues = [], [], [], [], []
    for i, (start, end, text) in enumerate(LINES):
        raw = os.path.join(tmp, "raw%02d.mp3" % i)
        asyncio.run(synth(text, raw))
        dur, slot = duration(raw), end - start
        tempo = max(1.0, dur / slot)
        print("line %2d  start %6.1fs  speech %5.1fs  slot %5.1fs  tempo %.2f" % (i, start, dur, slot, tempo))
        if tempo > 1.25:
            too_long.append(i)
        cues += split_cues(text, start, start + dur / tempo)
        inputs += ["-i", raw]
        ms = int(start * 1000)
        filters.append("[%d:a]atempo=%.3f,adelay=%d|%d,apad[a%d]" % (i + 1, tempo, ms, ms, i))
        labels.append("[a%d]" % i)
    if too_long:
        raise SystemExit("Lines too long for their slot (shorten the text): %s" % too_long)
    mix = "".join(labels) + "amix=inputs=%d:normalize=0:duration=longest,volume=1.4[aout]" % len(LINES)
    run(["-i", SRC] + inputs + ["-filter_complex", ";".join(filters) + ";" + mix,
                                "-map", "0:v", "-map", "[aout]", "-c:v", "copy",
                                "-c:a", "libopus", "-b:a", "96k", "-shortest", DST])
    write_srt(cues, SRT)
    print("Wrote", DST)
    print("Wrote", SRT)


if __name__ == "__main__":
    main()
