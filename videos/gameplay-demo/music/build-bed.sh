#!/bin/bash
# Build a ~230s music bed out of two 16.5s generations.
#
# Seed Audio returns short clips, so length has to come from arrangement rather
# than from the model. Fourteen identical loops would be unlistenable, so the
# bed is built in movements: a filtered version of the main loop opens, the
# main loop carries the body, the peak loop takes the match, a breakdown drops
# the energy, and the peak returns for the close.
#
# The "intro" is the main loop through a lowpass sweep rather than a third
# generation — the one that was asked for came back flagged, and deriving it
# guarantees it is in the same key and tempo as everything after it, which a
# separate generation would not.
#
# Loop joins are crossfaded. A hard cut between two copies of the same bar
# clicks, and the click is audible under a voice even when the music is quiet.
set -euo pipefail
cd "$(dirname "$0")"

XF=1.2          # crossfade seconds between loop copies
LOOPS_MAIN=5    # 16.5s each, minus crossfade
LOOPS_PEAK=4

# One loop of a source, repeated n times with crossfades.
chain() {
  local src=$1 n=$2 out=$3
  local args=() filter="" prev="0:a"
  for ((i = 0; i < n; i++)); do args+=(-i "$src"); done
  for ((i = 1; i < n; i++)); do
    filter+="[$prev][$i:a]acrossfade=d=$XF:c1=tri:c2=tri[x$i];"
    prev="x$i"
  done
  filter="${filter%;}"
  if [ "$n" -eq 1 ]; then
    ffmpeg -v error -i "$src" -c copy "$out" -y
  else
    ffmpeg -v error "${args[@]}" -filter_complex "$filter" -map "[$prev]" "$out" -y
  fi
}

# The opening: the main loop with the top rolled off, opening up over 12s.
ffmpeg -v error -i bed-raw.wav -af \
  "lowpass=f=700,volume=0.7,afade=t=in:st=0:d=3" \
  intro.wav -y

chain bed-raw.wav "$LOOPS_MAIN" main.wav
chain peak-raw.wav "$LOOPS_PEAK" peak.wav

# A breakdown: the peak loop, filtered and quieter, so the middle of the video
# has somewhere to breathe rather than running flat out for three minutes.
ffmpeg -v error -i peak-raw.wav -af "lowpass=f=1100,volume=0.6" break.wav -y

# intro → main → peak → breakdown → peak
ffmpeg -v error -i intro.wav -i main.wav -i peak.wav -i break.wav -i peak.wav \
  -filter_complex "\
[0:a][1:a]acrossfade=d=$XF:c1=tri:c2=tri[a];\
[a][2:a]acrossfade=d=$XF:c1=tri:c2=tri[b];\
[b][3:a]acrossfade=d=$XF:c1=tri:c2=tri[c];\
[c][4:a]acrossfade=d=$XF:c1=tri:c2=tri[d]" \
  -map "[d]" bed-long.wav -y

LEN=$(ffprobe -v error -show_entries format=duration -of csv=p=0 bed-long.wav)
echo "bed-long.wav  ${LEN}s"
