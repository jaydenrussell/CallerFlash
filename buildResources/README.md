# Build Resources

Place your app icons here:

- **`icon.ico`** — Windows application icon (256×256 minimum, multi-resolution recommended)
- **`icon.png`** — System tray icon (256×256)

### Generating icons

From a 1024×1024 source PNG:

```bash
# macOS/Linux — using ImageMagick
convert icon-source.png -resize 256x256 icon.png

# ICO with multiple resolutions
convert icon-source.png \
  \( -clone 0 -resize 16x16 \) \
  \( -clone 0 -resize 32x32 \) \
  \( -clone 0 -resize 48x48 \) \
  \( -clone 0 -resize 64x64 \) \
  \( -clone 0 -resize 128x128 \) \
  \( -clone 0 -resize 256x256 \) \
  -delete 0 icon.ico
```

Or use an online tool like [icoconvert.com](https://icoconvert.com/).
