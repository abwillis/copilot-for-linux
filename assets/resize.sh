for s in 1024 512 256 128 96 64 48 32 16; do
  magick copilot-for-linux.png \
    -resize "${s}x${s}" \
    -background none \
    -gravity center \
    -extent "${s}x${s}" \
    "copilot-for-linux_${s}x${s}.png"
done

for s in 1024 512 256 128 96 64 48 32 16; do
  magick copilot-for-linux.png \
    -filter Lanczos \
    -resize "${s}x${s}" \
    -background none \
    -gravity center \
    -extent "${s}x${s}" \
    "copilot-for-linux_${s}x${s}.png"
done

magick \
  copilot-for-linux_1024x1024.png \
  copilot-for-linux_512x512.png \
  copilot-for-linux_256x256.png \
  copilot-for-linux_128x128.png \
  copilot-for-linux_96x96.png \
  copilot-for-linux_64x64.png \
  copilot-for-linux_48x48.png \
  copilot-for-linux_32x32.png \
  copilot-for-linux_16x16.png \
  copilot-for-linux.ico

magick \
  copilot-for-linux_512x512.png \
  copilot-for-linux_256x256.png \
  copilot-for-linux_128x128.png \
  copilot-for-linux_96x96.png \
  copilot-for-linux_64x64.png \
  copilot-for-linux_48x48.png \
  copilot-for-linux_32x32.png \
  copilot-for-linux_16x16.png \
  copilot-for-linux.ico
