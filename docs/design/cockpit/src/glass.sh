#!/bin/sh
# Make the glass behind the window frame: one small, already blurred picture per brief artwork.
#
# Each artwork is shrunk, blurred and reduced to its light. That light is then drawn in Morndo's dawn colours:
# the painting's shadows become night blue, its light becomes a warm glow. Plain blurred paintings turn muddy
# brown when darkened; this keeps the frame dark enough for the sidebar's text and still different every day.
# The browser only stretches the result, it never blurs anything itself.
#
# Needs ImageMagick 7. usage: sh glass.sh   (reads heroes/*.webp, writes glass/*.webp, 64 x 42 px each)
set -eu
cd "$(dirname "$0")"
mkdir -p glass
ramp=$(mktemp -t ramp).png
# night blue, sea blue, dusk mauve, amber. The amber is as light as the sidebar's small grey text allows.
magick \( -size 96x1 "gradient:#0a1226-#11293d" \) \( -size 80x1 "gradient:#11293d-#30283f" \) \
       \( -size 80x1 "gradient:#30283f-#4e3013" \) +append "$ramp"
for f in heroes/*.webp; do
  n=$(basename "$f" .webp)
  # Stored without loss: at this size a lossy file shows its blocks once it is stretched over a whole window.
  magick "$f" -resize "96x64!" -blur 0x8 -colorspace Gray -auto-level -sigmoidal-contrast "3x50%" \
         "$ramp" -clut -resize "64x42!" -define webp:lossless=true -define webp:method=6 "glass/$n.webp"
done
rm -f "$ramp"
ls glass | wc -l
